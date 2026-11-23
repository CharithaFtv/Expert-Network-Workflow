import type { MailTransport, OutgoingMail } from "./transport.ts";

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
};

export function graphConfigFromEnv(env = process.env): GraphConfig {
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

/** Sends from one shared mailbox using the OAuth client-credentials flow. */
export class GraphMailTransport implements MailTransport {
  private token?: { value: string; expiresAt: number };

  private cfg: GraphConfig;
  private fetchFn: typeof fetch;

  constructor(cfg: GraphConfig, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.fetchFn(
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
    if (!res.ok) throw new Error(`Graph token request failed: ${res.status} ${await safeText(res)}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  async send(mail: OutgoingMail): Promise<void> {
    const token = await this.accessToken();
    const res = await this.fetchFn(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.cfg.mailbox)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: mail.subject,
            body: { contentType: "Text", content: mail.body },
            toRecipients: [{ emailAddress: { address: mail.to } }],
          },
          saveToSentItems: true,
        }),
      },
    );
    if (res.status === 401) this.token = undefined; // force a fresh token next attempt
    if (res.status !== 202) throw new Error(`Graph sendMail failed: ${res.status} ${await safeText(res)}`);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
