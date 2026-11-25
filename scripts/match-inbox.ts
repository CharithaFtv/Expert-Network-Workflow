import { closeDb, db } from "../src/lib/db.ts";
import { assignToProject, matchPending } from "../src/lib/mail/match.ts";

// Usage:
//   npm run match-inbox                      match everything still waiting (poll-inbox already does this)
//   npm run match-inbox -- --list            show messages that need a person (Unmatched or Unverified)
//   npm run match-inbox -- --assign 12 3     put message 12 on project 3 (the sender check still applies)
let exitCode = 0;
try {
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    const rows = await db.query(
      `SELECT m.id, m.status, m.from_address, m.subject, m.received_at, p.code AS project
       FROM inbound_messages m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.status IN ('Unmatched', 'Unverified') ORDER BY m.received_at`,
    );
    if (rows.length) console.table(rows);
    else console.log("nothing needs a person");
  } else if (args[0] === "--assign") {
    const id = Number(args[1]);
    const project = Number(args[2]);
    if (!Number.isInteger(id) || !Number.isInteger(project)) throw new Error("usage: --assign MESSAGE_ID PROJECT_ID");
    console.log(await assignToProject(id, project));
  } else {
    console.log("match-inbox:", await matchPending());
  }
} catch (e) {
  console.error(`match-inbox: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
