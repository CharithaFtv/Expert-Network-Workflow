import { GraphClient, safeText } from "./graph.ts";
import { MailError } from "./transport.ts";
import type { AttachmentInfo, AttachmentSource } from "./attachments.ts";

/** One received email, as Graph describes it. */
export type InboundMessage = {
  graphId: string;
  internetMessageId: string | null;
  conversationId: string | null;
  receivedAt: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  subject: string;
  bodyType: "html" | "text";
  body: string;
  hasAttachments: boolean;
  headers: { name: string; value: string }[] | null;
};

/** The saved delta link is no longer valid (Graph expires them); the caller restarts from `since`. */
export class CursorExpiredError extends Error {}

/** Where the poller reads from. Graph in production, a fake in tests. */
export interface InboxReader {
  /** Identifies what is being followed (mailbox and folder). The saved cursor is keyed by it, so a different mailbox never reuses it. */
  readonly name: string;
  /**
   * Walks every change after `cursor` (or the whole Inbox when there is none), page by page, and drops
   * messages received before `since`. `onPage`
   * gets each page with `checkpoint`, a link the walk can safely resume from once the page is handled
   * (null on the last page). Returns the final delta link.
   */
  readChanges(
    cursor: string | null,
    since: Date,
    onPage: (messages: InboundMessage[], checkpoint: string | null) => Promise<void>,
  ): Promise<string>;
}

const SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "receivedDateTime",
  "from",
  "toRecipients",
  "subject",
  "body",
  "hasAttachments",
  "internetMessageHeaders",
  "isDraft",
].join(",");

type GraphMessage = {
  id: string;
  "@removed"?: unknown;
  internetMessageId?: string;
  conversationId?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  subject?: string;
  body?: { contentType?: string; content?: string };
  hasAttachments?: boolean;
  internetMessageHeaders?: { name: string; value: string }[];
  isDraft?: boolean;
};

export function toInboundMessage(m: GraphMessage): InboundMessage {
  return {
    graphId: m.id,
    internetMessageId: m.internetMessageId ?? null,
    conversationId: m.conversationId ?? null,
    receivedAt: m.receivedDateTime ?? new Date().toISOString(),
    fromAddress: m.from?.emailAddress?.address?.trim().toLowerCase() ?? null,
    fromName: m.from?.emailAddress?.name ?? null,
    toAddresses: (m.toRecipients ?? [])
      .map((r) => r.emailAddress?.address?.trim().toLowerCase())
      .filter((a): a is string => !!a),
    subject: m.subject ?? "",
    bodyType: m.body?.contentType?.toLowerCase() === "html" ? "html" : "text",
    body: m.body?.content ?? "",
    hasAttachments: !!m.hasAttachments,
    headers: m.internetMessageHeaders ?? null,
  };
}

// A runaway nextLink loop must not run forever. Hitting the cap is not a stall: the caller has saved a
// checkpoint after every page, so the next run carries on from where this one stopped.
const MAX_PAGES = 200;
const MAX_ATTACHMENT_PAGES = 20;

/** Reads the Inbox through a Graph delta query using immutable message IDs. Needs Application Mail.Read. */
export class GraphInbox extends GraphClient implements InboxReader, AttachmentSource {
  get name() {
    return `${this.cfg.mailbox.toLowerCase()}/inbox`;
  }

  async readChanges(
    cursor: string | null,
    since: Date,
    onPage: (messages: InboundMessage[], checkpoint: string | null) => Promise<void>,
  ): Promise<string> {
    let url =
      cursor ??
      `/mailFolders/inbox/messages/delta?$select=${SELECT}`;
    const headers = { Prefer: 'IdType="ImmutableId", odata.maxpagesize=50' };

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.api(url, { headers });
      if (res.status === 410) throw new CursorExpiredError("Delta link expired");
      if (!res.ok) {
        throw new MailError(`Graph inbox read failed: ${res.status} ${await safeText(res)}`, "run");
      }
      const json = (await res.json()) as {
        value: GraphMessage[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      };
      // Deletions arrive as "@removed" stubs; drafts are never mail we received.
      // The lookback is applied here, not with $filter: Graph caps a filtered delta query at 5,000
      // messages and would silently leave the rest out while still handing back a final token.
      const live = json.value
        .filter((m) => !m["@removed"] && !m.isDraft)
        .map(toInboundMessage)
        .filter((m) => new Date(m.receivedAt).getTime() >= since.getTime());
      const nextLink = json["@odata.nextLink"] ?? null;
      if (live.length || nextLink) await onPage(live, nextLink);
      if (json["@odata.deltaLink"]) return json["@odata.deltaLink"];
      if (!nextLink) throw new MailError("Graph delta ended without a deltaLink", "run");
      url = nextLink;
    }
    throw new MailError(`Graph delta exceeded ${MAX_PAGES} pages`, "run");
  }

  /** Name, type and size of each attachment of a message. Nothing is downloaded. */
  async listAttachments(graphId: string): Promise<AttachmentInfo[]> {
    const headers = { Prefer: 'IdType="ImmutableId"' };
    let url: string | undefined =
      `/messages/${encodeURIComponent(graphId)}/attachments?$select=id,name,contentType,size,isInline`;
    const out: AttachmentInfo[] = [];
    // Follow the paging links: stopping after the first page would leave later attachments unrecorded
    // while the message is marked done. A runaway list is an error, so the message is retried and then
    // reported instead of being half-recorded.
    for (let page = 0; url; page++) {
      if (page >= MAX_ATTACHMENT_PAGES) {
        throw new MailError(`Graph attachment list exceeded ${MAX_ATTACHMENT_PAGES} pages`, "run");
      }
      const res = await this.api(url, { headers });
      if (!res.ok) throw new MailError(`Graph attachment list failed: ${res.status} ${await safeText(res)}`, "run");
      const json = (await res.json()) as {
        value: {
          id: string;
          name?: string;
          contentType?: string;
          size?: number;
          isInline?: boolean;
          "@odata.type"?: string;
        }[];
        "@odata.nextLink"?: string;
      };
      for (const a of json.value) {
        out.push({
          id: a.id,
          name: a.name ?? "unnamed",
          contentType: a.contentType ?? null,
          size: a.size ?? 0,
          isInline: !!a.isInline,
          kind:
            a["@odata.type"] === "#microsoft.graph.fileAttachment"
              ? "file"
              : a["@odata.type"] === "#microsoft.graph.referenceAttachment"
                ? "reference"
                : "item",
        });
      }
      url = json["@odata.nextLink"];
    }
    return out;
  }

  /** The raw bytes of one file attachment. The caller has already decided it is small enough. */
  async downloadAttachment(graphId: string, attachmentId: string): Promise<Buffer> {
    const res = await this.api(
      `/messages/${encodeURIComponent(graphId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
      { headers: { Prefer: 'IdType="ImmutableId"' } },
    );
    if (!res.ok) throw new MailError(`Graph attachment download failed: ${res.status} ${await safeText(res)}`, "run");
    return Buffer.from(await res.arrayBuffer());
  }
}
