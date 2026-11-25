import { closeDb } from "../src/lib/db.ts";
import { graphConfigFromEnv } from "../src/lib/mail/graph.ts";
import { pollInbox } from "../src/lib/mail/inbound.ts";
import { GraphInbox } from "../src/lib/mail/inbox.ts";
import { extractionClientFromEnv } from "../src/lib/ai/config.ts";
import type { ModelClient } from "../src/lib/ai/model.ts";

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

  // Extraction (step 3e) is off unless EXTRACTION_MODE=on. If it is on but not set up, say so and carry on
  // without it: the mailbox is read either way.
  let extractor: ModelClient | null = null;
  try {
    extractor = extractionClientFromEnv();
  } catch (e) {
    console.error(`extraction is not available: ${(e as Error).message} Polling without it.`);
    exitCode = 1;
  }
  if (extractor && !dryRun) {
    console.log(`extraction is ON: the cleaned text of verified replies is sent to the Claude API (${extractor.model}).`);
  }

  const reader = new GraphInbox(graphConfigFromEnv());
  const result = await pollInbox(reader, {
    since,
    dryRun,
    extractor,
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
  if (result.extraction?.aborted) {
    console.error(`extraction stopped: ${result.extraction.aborted}. Check the API key and access; nothing was marked.`);
    exitCode = 1;
  }
  if (result.extraction?.deferred) {
    console.error(`${result.extraction.deferred} message(s) could not reach the model this time and will be tried again.`);
  }
  if (result.extraction?.manual) {
    console.log(`${result.extraction.manual} message(s) are marked "Needs manual entry": the model could not handle them.`);
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
