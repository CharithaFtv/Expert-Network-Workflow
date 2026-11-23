import { GraphMailTransport, graphConfigFromEnv } from "./graph.ts";
import type { MailTransport } from "./transport.ts";

/** MAIL_MODE=graph sends for real; anything else (default) only logs. */
export function transportFromEnv(env = process.env): MailTransport {
  if (env.MAIL_MODE === "graph") return new GraphMailTransport(graphConfigFromEnv(env));
  return {
    async send(m) {
      console.log(`[mail:log] to=${m.to} subject=${JSON.stringify(m.subject)}`);
    },
  };
}
