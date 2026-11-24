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

/** Talks to one shared mailbox using the OAuth client-credentials flow. Sending and reading extend it. */
export class GraphClient {
  private token?: { value: string; expiresAt: number };

  protected cfg: GraphConfig;
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

  /**
   * Authenticated call to the mailbox; a 401 refreshes the token and retries once. `path` is relative
   * to the mailbox, or an absolute Graph URL (paging links). Any other host is refused so the token
   * can never be sent anywhere else.
   */
  protected async api(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("https://")
      ? path
      : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.cfg.mailbox)}${path}`;
    if (new URL(url).host !== "graph.microsoft.com") {
      throw new MailError(`Refusing to call non-Graph URL: ${new URL(url).host}`, "run");
    }
    const go = async () => {
      const headers = new Headers(init.headers); // accepts a plain object, a Headers or pairs
      headers.set("Authorization", `Bearer ${await this.accessToken()}`);
      if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      return this.call(url, { ...init, headers });
    };
    let res = await go();
    if (res.status === 401) {
      this.token = undefined; // revoked or rotated early
      res = await go();
    }
    return res;
  }

}

/** Sends from the shared mailbox. */
export class GraphMailTransport extends GraphClient implements MailTransport {
  /**
   * Uses sendMail, which needs only Application Mail.Send on the shared mailbox (what Exchange
   * RBAC grants today). It returns an empty 202, so no thread IDs here: replies are matched by the
   * project code in the subject, and the inbound poller records the conversationId from the
   * first reply it sees.
   */
  async send(mail: OutgoingMail): Promise<SendReceipt> {
    const res = await this.api("/sendMail", {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: "Text", content: mail.body },
          toRecipients: [{ emailAddress: { address: mail.to } }],
        },
        saveToSentItems: true,
      }),
    });
    if (res.status === 202) return {};
    const detail = `Graph sendMail failed: ${res.status} ${await safeText(res)}`;
    throw new MailError(detail, PERMANENT.has(res.status) ? "permanent" : "run");
  }
}

export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
