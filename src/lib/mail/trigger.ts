import { mailMode, sendPolicy, transportFromEnv } from "./index.ts";
import { drainOutbox, type SendResult } from "./sender.ts";

/**
 * Manual trigger: called right after a request is submitted (and later for follow-ups) to deliver
 * that project's queued mail. The project is already saved, so a failure here never fails the
 * request: unsent rows stay Queued and can be retried with `npm run send-outbox`.
 * Does nothing unless MAIL_MODE=graph.
 */
export async function sendProjectMail(
  projectId: number,
  env: Record<string, string | undefined> = process.env,
): Promise<SendResult | { skipped: string } | { error: string }> {
  try {
    if (mailMode(env) !== "graph") return { skipped: "MAIL_MODE is not graph; mail stays queued" };
    const policy = sendPolicy(env);
    const result = await drainOutbox(transportFromEnv(env), { projectId, ...policy });
    console.log(`[mail] project ${projectId}:`, result);
    return result;
  } catch (e) {
    console.error(`[mail] project ${projectId} not sent: ${(e as Error).message}`);
    return { error: (e as Error).message };
  }
}
