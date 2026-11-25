import { closeDb, db } from "../src/lib/db.ts";
import { extractionClientFromEnv, extractionMode } from "../src/lib/ai/config.ts";
import { extractPending, pendingMessages, prepareInput } from "../src/lib/ai/extract.ts";
import { CLASSIFY_SYSTEM, EXTRACT_SYSTEM, neutralise, PROMPT_VERSION, userMessage } from "../src/lib/ai/prompts.ts";

// Usage:
//   npm run extract-inbox -- --status          how many verified replies are waiting, and what has been done
//   npm run extract-inbox -- --preview         print EXACTLY what would be sent to the model for the next message
//                                              (nothing is sent)
//   npm run extract-inbox                      run extraction now (needs EXTRACTION_MODE=on and ANTHROPIC_API_KEY)
//   npm run extract-inbox -- --retry-manual    forget the "Needs manual entry" marks and try those messages again
// poll-inbox runs extraction too when it is on; this is for looking, and for running it by hand.
let exitCode = 0;
try {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    console.log(`extraction mode: ${extractionMode()}   prompt version: ${PROMPT_VERSION}`);
    console.table(
      await db.query(
        `SELECT COALESCE(e.status, 'Waiting') AS status, COUNT(*) AS messages
         FROM inbound_messages m LEFT JOIN extractions e ON e.message_id = m.id
         WHERE m.status = 'Matched' AND m.cleaned_at IS NOT NULL AND m.purged_at IS NULL
         GROUP BY 1 ORDER BY 1`,
      ),
    );
    console.table(
      await db.query(
        "SELECT match_status, review_status, COUNT(*) AS candidates FROM extracted_candidates GROUP BY 1, 2 ORDER BY 1, 2",
      ),
    );
  } else if (args.includes("--preview")) {
    const [m] = await pendingMessages(1);
    if (!m) {
      console.log("no verified reply is waiting for extraction");
    } else {
      console.log(`--- message ${m.id}. Nothing below has been sent anywhere. ---\n`);
      console.log(`SYSTEM (step 1, classify):\n${CLASSIFY_SYSTEM}\n`);
      console.log(`SYSTEM (step 2, extract, only for expert proposals and updates):\n${EXTRACT_SYSTEM}\n`);
      console.log(`USER (the same text goes to both steps):\n${userMessage(prepareInput(m.text_clean).text, m.hosts ?? [])}`);
    }
  } else {
    if (args.includes("--retry-manual")) {
      const rows = await db.query(
        `DELETE FROM extractions e WHERE e.status = 'Needs manual entry' AND NOT EXISTS
           (SELECT 1 FROM extracted_candidates c WHERE c.extraction_id = e.id AND c.review_status = 'Confirmed') RETURNING message_id`,
      );
      await db.query("UPDATE inbound_messages SET extraction_attempts = 0, extraction_error = NULL WHERE id = ANY($1)", [
        rows.map((r) => (r as { message_id: number }).message_id),
      ]);
      console.log(`${rows.length} message(s) will be tried again`);
    }
    const client = extractionClientFromEnv();
    if (!client) {
      console.log("extraction is off (EXTRACTION_MODE is not \"on\"): nothing was sent. Use --preview to see what would be.");
    } else {
      console.log(`sending the cleaned text of waiting verified replies to the model API (${client.model})`);
      const r = await extractPending(client);
      console.log(r);
      if (r.aborted) exitCode = 1;
    }
  }
} catch (e) {
  console.error(`extract-inbox: ${(e as Error).message}`);
  exitCode = 1;
} finally {
  await closeDb();
}
process.exit(exitCode);
