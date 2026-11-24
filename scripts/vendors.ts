import { closeDb, db } from "../src/lib/db.ts";

// Manage expert network vendors and their intake addresses.
//   npm run vendors -- list
//   npm run vendors -- add "Name" address@domain
//   npm run vendors -- set-email "Name" address@domain|none
// A vendor without an intake address is not offered on the request form.
const [cmd, name, email] = process.argv.slice(2);
const validEmail = (e?: string) => !!e && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e);
let exitCode = 0;
try {
  if (cmd === "list") {
    console.table(await db.query("SELECT id, name, intake_email, active FROM vendors ORDER BY id"));
  } else if (cmd === "add" && name && validEmail(email)) {
    await db.query("INSERT INTO vendors (name, intake_email) VALUES ($1, $2)", [name, email.toLowerCase()]);
    console.log(`added ${name} <${email.toLowerCase()}>`);
  } else if (cmd === "set-email" && name && (email === "none" || validEmail(email))) {
    const rows = await db.query("UPDATE vendors SET intake_email = $2 WHERE name = $1 RETURNING id", [
      name,
      email === "none" ? null : email.toLowerCase(),
    ]);
    if (!rows.length) throw new Error(`no vendor named "${name}"`);
    console.log(`${name}: intake email ${email === "none" ? "cleared" : `set to ${email.toLowerCase()}`}`);
  } else {
    console.error('usage: vendors list | add "Name" email | set-email "Name" email|none');
    exitCode = 1;
  }
} catch (e) {
  console.error(`vendors: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
