import { MailError, type MailTransport, type OutgoingMail, type SendReceipt } from "./transport.ts";

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
};

export function graphConfigFromEnv(env: Record<string, string | undefined> = process.env): GraphConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`Missing ${k}`);
    return v;
  };
  return {
    tenantId: need("GRAPH_TENANT_ID"),
    clientId: need("GRAPH_CLIENT_ID"),
    clientSecret: need("GRAPH_CLIENT_SECRET"),
    mailbox: need("GRAPH_MAILBOX"),
  };
}

const TIMEOUT_MS = 20_000;
/** HTTP statuses that mean this one message is bad, not that Graph or our credentials are. */
const PERMANENT = new Set([400, 404, 413, 422]);

/** Sends from one shared mailbox using the OAuth client-credentials flow. */
export class GraphMailTransport implements MailTransport {
  private token?: { value: string; expiresAt: number };

  private cfg: GraphConfig;
  private fetchFn: typeof fetch;

  constructor(cfg: GraphConfig, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  /** fetch with a hard timeout; network errors and timeouts become run-level failures. */
  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new MailError(`Graph request failed: ${(e as Error).message}`, "run");
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.call(
      `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );
    if (!res.ok) throw new MailError(`Graph token request failed: ${res.status} ${await safeText(res)}`, "run");
    const json = (await res.json()) as { access_token: string; expires_in?: number | string };
    const ttl = Number(json.expires_in) || 3600;
    this.token = { value: json.access_token, expiresAt: Date.now() + ttl * 1000 };
    return json.access_token;
  }

  /** Authenticated call to the mailbox; a 401 refreshes the token and retries once. */
  private async api(path: string, init: RequestInit): Promise<Response> {
    const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.cfg.mailbox)}${path}`;
    const go = async () =>
      this.call(url, {
        ...init,
        headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      });
    let res = await go();
    if (res.status === 401) {
      this.token = undefined; // revoked or rotated early
      res = await go();
    }
    return res;
  }

  private async fail(what: string, res: Response): Promise<never> {
    const detail = `Graph ${what} failed: ${res.status} ${await safeText(res)}`;
    throw new MailError(detail, PERMANENT.has(res.status) ? "permanent" : "run");
  }

  /**
   * sendMail returns 202 with no IDs, so we create a draft (which returns the thread IDs) and
   * then send it. It is saved to Sent Items either way.
   */
  async send(mail: OutgoingMail): Promise<SendReceipt> {
    const create = await this.api("/messages", {
      method: "POST",
      body: JSON.stringify({
        subject: mail.subject,
        body: { contentType: "Text", content: mail.body },
        toRecipients: [{ emailAddress: { address: mail.to } }],
      }),
    });
    if (create.status !== 201) return this.fail("create draft", create);
    const draft = (await create.json()) as { id: string; conversationId?: string; internetMessageId?: string };

    const sent = await this.api(`/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
    if (sent.status !== 202) {
      // Best effort: do not leave an orphan draft behind a failed send.
      await this.api(`/messages/${encodeURIComponent(draft.id)}`, { method: "DELETE" }).catch(() => {});
      return this.fail("send draft", sent);
    }
    return { conversationId: draft.conversationId, internetMessageId: draft.internetMessageId };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
