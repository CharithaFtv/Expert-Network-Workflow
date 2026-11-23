import { closeDb, db } from "../src/lib/db.ts";
import { transportFromEnv } from "../src/lib/mail/index.ts";
import { drainOutbox } from "../src/lib/mail/sender.ts";

const mode = process.env.MAIL_MODE === "graph" ? "graph" : "log";
const redirectTo = process.env.MAIL_DEV_RECIPIENT || undefined;
if (mode === "graph" && !redirectTo && process.env.NODE_ENV !== "production") {
  console.error("Refusing to send for real without MAIL_DEV_RECIPIENT outside production.");
  process.exit(1);
}
console.log(`outbox sender: mode=${mode}${redirectTo ? ` redirect=${redirectTo}` : ""}`);
if (mode === "log") {
  // Dry run: show what is waiting, change nothing.
  const rows = await db.query("SELECT id, recipient, subject FROM outbox WHERE status = 'Queued' ORDER BY id");
  console.log(`${rows.length} queued (dry run, nothing sent, nothing marked)`);
  for (const r of rows) console.log(r);
} else {
  console.log(await drainOutbox(transportFromEnv(), { redirectTo }));
}
await closeDb();
