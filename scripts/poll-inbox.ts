import { closeDb } from "../src/lib/db.ts";
import { graphConfigFromEnv } from "../src/lib/mail/graph.ts";
import { pollInbox } from "../src/lib/mail/inbound.ts";
import { GraphInbox } from "../src/lib/mail/inbox.ts";

// Usage: npm run poll-inbox [-- --dry-run] [-- --since 2026-11-20]
// Reads the shared mailbox Inbox (Graph delta query). --dry-run prints what is there and stores nothing.
// --since only matters for the first run (or after a cursor expires): it limits how far back to read.
let exitCode = 0;
try {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const i = args.indexOf("--since");
  const since = i >= 0 ? new Date(args[i + 1]) : undefined;
  if (since && Number.isNaN(since.getTime())) throw new Error("--since needs a date like 2026-11-20");

  const reader = new GraphInbox(graphConfigFromEnv());
  const result = await pollInbox(reader, {
    since,
    dryRun,
    onMessage: dryRun
      ? (m) => console.log(`${m.receivedAt}  ${m.fromAddress ?? "?"}  ${m.subject}  ${m.hasAttachments ? "[attachments]" : ""}`)
      : undefined,
  });
  console.log(`poll-inbox${dryRun ? " (dry run, nothing stored)" : ""}:`, result);
  if (result.failed.length) {
    console.error(`${result.failed.length} message(s) could not be stored. They are kept in the inbound_failures table: ${result.failed.join(", ")}`);
    exitCode = 1;
  }
  for (const err of result.errors) {
    console.error(`messages were stored, but a follow-up step failed (${err}). The next poll retries it.`);
    exitCode = 1;
  }
  if (result.attachments?.failed) {
    console.error(`attachments could not be fetched for ${result.attachments.failed} message(s); the next poll retries them: ${result.attachments.errors.join("; ")}`);
    exitCode = 1;
  }
  if (result.cleaning?.failed) {
    console.error(`cleaning failed for ${result.cleaning.failed} message(s); the next poll retries them: ${result.cleaning.errors.join("; ")}`);
    exitCode = 1;
  }
  if (result.cleaning?.abandoned) {
    console.error(`${result.cleaning.abandoned} message(s) could not be cleaned after several tries; they need a person.`);
    exitCode = 1;
  }
  if (result.attachments?.abandoned) {
    console.error(`${result.attachments.abandoned} message(s) had attachments that kept failing and were given up on; they need a person.`);
    exitCode = 1;
  }
} catch (e) {
  console.error(`poll-inbox: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
