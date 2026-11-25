import { closeDb } from "../src/lib/db.ts";
import { purgeExpired } from "../src/lib/mail/attachments.ts";
import { backfillRetention, dueForPurge } from "../src/lib/mail/retention.ts";

// Usage:
//   npm run purge-inbox                                   dry run: lists what would be purged, changes nothing
//   npm run purge-inbox -- --apply                        purges mail whose retention date has passed
//                                                         (clears body, headers and attachment bytes; rows stay)
//   npm run purge-inbox -- --apply --include-closed       first dates mail on projects that were closed before a
//                                                         retention period was set, then purges what is due
// A project's mail gets its retention date when the project is closed, and only when
// RETENTION_DAYS_AFTER_CLOSE is set; while it is empty nothing is ever due. Mail on projects that closed
// earlier is NOT touched unless you pass --include-closed, because that is retroactive and can purge old
// mail at once. Purging cannot be undone.
let exitCode = 0;
try {
  const includeClosed = process.argv.includes("--include-closed");
  if (process.argv.includes("--apply")) {
    if (includeClosed) {
      const dated = await backfillRetention();
      console.log(`gave ${dated} message(s) on already-closed projects a retention date`);
    }
    console.log(`purged ${await purgeExpired()} message(s)`);
  } else {
    const now = new Date();
    const due = await dueForPurge(now, process.env, false);
    if (due.length) console.table(due);
    else console.log("nothing with a retention date is due for purging");
    // Show what --include-closed would add, so nobody is surprised by it.
    const withClosed = await dueForPurge(now, process.env, true);
    const dueBy = new Map(due.map((d) => [d.project, d.messages]));
    const extra = withClosed
      .map((d) => ({ project: d.project, messages: d.messages - (dueBy.get(d.project) ?? 0), attachments: d.attachments }))
      .filter((d) => d.messages > 0);
    if (extra.length) {
      console.log("also due if you pass --include-closed (mail on projects closed before a period was set):");
      console.table(extra);
    }
    console.log("dry run: nothing was changed. Run with --apply to purge.");
  }
} catch (e) {
  console.error(`purge-inbox: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
