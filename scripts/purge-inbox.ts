import { closeDb } from "../src/lib/db.ts";
import { purgeExpired } from "../src/lib/mail/attachments.ts";
import { backfillRetention, dueForPurge } from "../src/lib/mail/retention.ts";

// Usage:
//   npm run purge-inbox              dry run: lists what would be purged, changes nothing
//   npm run purge-inbox -- --apply   dates mail on already-closed projects, then purges what is due
//                                    (clears body, headers and attachment bytes; the rows stay)
// A project's mail gets its retention date when the project is closed, and only when
// RETENTION_DAYS_AFTER_CLOSE is set; while it is empty nothing is ever due. Setting it later covers
// projects that were closed earlier too. Purging cannot be undone.
let exitCode = 0;
try {
  if (process.argv.includes("--apply")) {
    const dated = await backfillRetention();
    if (dated) console.log(`gave ${dated} message(s) on already-closed projects a retention date`);
    console.log(`purged ${await purgeExpired()} message(s)`);
  } else {
    const rows = await dueForPurge();
    if (rows.length) console.table(rows);
    else console.log("nothing is due for purging");
    console.log("dry run: nothing was changed. Run with --apply to purge.");
  }
} catch (e) {
  console.error(`purge-inbox: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
