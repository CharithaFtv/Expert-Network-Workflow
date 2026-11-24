import { GraphMailTransport, graphConfigFromEnv } from "./graph.ts";
import type { MailTransport } from "./transport.ts";

/** MAIL_MODE: "log" (default, dry run) or "graph" (sends for real). Anything else is an error. */
export function mailMode(env: Record<string, string | undefined> = process.env): "log" | "graph" {
  const m = env.MAIL_MODE?.trim() || "log";
  if (m !== "log" && m !== "graph") throw new Error(`MAIL_MODE must be "log" or "graph", got "${m}"`);
  return m;
}

export function transportFromEnv(env: Record<string, string | undefined> = process.env): MailTransport {
  if (mailMode(env) === "graph") return new GraphMailTransport(graphConfigFromEnv(env));
  return {
    async send(m) {
      console.log(`[mail:log] to=${m.to} subject=${JSON.stringify(m.subject)}`);
    },
  };
}
