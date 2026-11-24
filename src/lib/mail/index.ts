import { GraphMailTransport, graphConfigFromEnv } from "./graph.ts";
import type { MailTransport } from "./transport.ts";

/** MAIL_MODE: "log" (default, dry run) or "graph" (sends for real). Anything else is an error. */
export function mailMode(env: Record<string, string | undefined> = process.env): "log" | "graph" {
  const m = env.MAIL_MODE?.trim() || "log";
  if (m !== "log" && m !== "graph") throw new Error(`MAIL_MODE must be "log" or "graph", got "${m}"`);
  return m;
}

/**
 * Who a real send may reach. MAIL_ALLOWED_RECIPIENTS (comma separated) is an allowlist: anything
 * else is Blocked and never sent. MAIL_DEV_RECIPIENT redirects everything to one address.
 * Outside production, real sending needs at least one of them, so a test run can never
 * reach an external vendor by accident.
 */
export function sendPolicy(env: Record<string, string | undefined> = process.env) {
  const redirectTo = env.MAIL_DEV_RECIPIENT?.trim().toLowerCase() || undefined;
  const allowed = (env.MAIL_ALLOWED_RECIPIENTS ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  if (mailMode(env) === "graph" && env.NODE_ENV !== "production" && !redirectTo && !allowed.length) {
    throw new Error("Refusing to send for real outside production without MAIL_ALLOWED_RECIPIENTS or MAIL_DEV_RECIPIENT.");
  }
  return { redirectTo, allowedRecipients: allowed.length ? allowed : undefined };
}

export function transportFromEnv(env: Record<string, string | undefined> = process.env): MailTransport {
  if (mailMode(env) === "graph") return new GraphMailTransport(graphConfigFromEnv(env));
  return {
    async send(m) {
      console.log(`[mail:log] to=${m.to} subject=${JSON.stringify(m.subject)}`);
    },
  };
}
