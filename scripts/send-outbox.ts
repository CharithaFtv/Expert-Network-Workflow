import { closeDb, db } from "../src/lib/db.ts";
import { mailMode, transportFromEnv } from "../src/lib/mail/index.ts";
import { drainOutbox, requeueFailed } from "../src/lib/mail/sender.ts";

// Usage: npm run send-outbox [-- --requeue-failed]
// MAIL_MODE=log (default) is a dry run; MAIL_MODE=graph sends for real.
let exitCode = 0;
try {
  const mode = mailMode();
  const redirectTo = process.env.MAIL_DEV_RECIPIENT || undefined;
  if (mode === "graph" && !redirectTo && process.env.NODE_ENV !== "production") {
    throw new Error("Refusing to send for real without MAIL_DEV_RECIPIENT unless NODE_ENV=production.");
  }
  console.log(`outbox sender: mode=${mode}${redirectTo ? ` redirect=${redirectTo}` : ""}`);

  if (process.argv.includes("--requeue-failed")) {
    console.log(`requeued ${await requeueFailed()} failed message(s)`);
  }

  if (mode === "log") {
    // Dry run: show what is waiting, change nothing.
    const rows = await db.query("SELECT id, recipient, subject FROM outbox WHERE status = 'Queued' ORDER BY id");
    console.log(`${rows.length} queued (dry run, nothing sent, nothing marked)`);
    for (const r of rows) console.log(r);
  } else {
    const result = await drainOutbox(transportFromEnv(), { redirectTo });
    console.log(result);
    if (result.aborted) console.error(`Run stopped early: ${result.aborted}`);
    if (result.stuck) console.error(`${result.stuck} message(s) stuck in Sending: check Sent Items before resolving by hand.`);
    if (result.aborted || result.stuck || result.failed) exitCode = 1;
  }
} catch (e) {
  console.error(`send-outbox: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
