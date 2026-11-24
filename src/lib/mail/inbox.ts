import { GraphClient, safeText } from "./graph.ts";
import { MailError } from "./transport.ts";

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
  /**
   * Walks every change after `cursor` (or after `since` when there is none), page by page. Returns the
   * new cursor, which the caller saves only after every page was handled.
   */
  readChanges(
    cursor: string | null,
    since: Date,
    onPage: (messages: InboundMessage[]) => Promise<void>,
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

const MAX_PAGES = 200; // a runaway nextLink loop must not run forever

/** Reads the Inbox through a Graph delta query using immutable message IDs. Needs Application Mail.Read. */
export class GraphInbox extends GraphClient implements InboxReader {
  async readChanges(
    cursor: string | null,
    since: Date,
    onPage: (messages: InboundMessage[]) => Promise<void>,
  ): Promise<string> {
    let url =
      cursor ??
      `/mailFolders/inbox/messages/delta?$select=${SELECT}` +
        `&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}`;
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
      const live = json.value.filter((m) => !m["@removed"] && !m.isDraft).map(toInboundMessage);
      if (live.length) await onPage(live);
      if (json["@odata.deltaLink"]) return json["@odata.deltaLink"];
      if (!json["@odata.nextLink"]) throw new MailError("Graph delta ended without a deltaLink", "run");
      url = json["@odata.nextLink"];
    }
    throw new MailError(`Graph delta exceeded ${MAX_PAGES} pages`, "run");
  }
}
