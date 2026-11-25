import { closeDb, db } from "../src/lib/db.ts";
import { purgeExpired } from "../src/lib/mail/attachments.ts";

// Usage:
//   npm run purge-inbox              dry run: lists what would be purged, changes nothing
//   npm run purge-inbox -- --apply   purges it: clears body, headers and attachment bytes (the rows stay)
// Only messages whose retain_until has passed are touched. A project's mail gets that date when the
// project is closed (see RETENTION_DAYS_AFTER_CLOSE). Purging cannot be undone.
let exitCode = 0;
try {
  if (process.argv.includes("--apply")) {
    console.log(`purged ${await purgeExpired()} message(s)`);
  } else {
    const rows = await db.query(
      `SELECT p.code AS project, COUNT(*) AS messages,
              (SELECT COUNT(*) FROM inbound_attachments a WHERE a.status = 'Stored'
                 AND a.message_id = ANY(array_agg(m.id))) AS attachments
       FROM inbound_messages m JOIN projects p ON p.id = m.project_id
       WHERE m.retain_until IS NOT NULL AND m.retain_until <= $1 AND m.purged_at IS NULL
       GROUP BY p.code ORDER BY p.code`,
      [new Date().toISOString()],
    );
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
