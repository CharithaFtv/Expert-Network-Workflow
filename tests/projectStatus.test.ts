import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { purgeExpired } from "@/lib/mail/attachments";
import { matchPending } from "@/lib/mail/match";
import { createProject } from "@/lib/projects";
import {
  changeProjectStatus,
  nextStatuses,
  retainUntilAfterClose,
  retentionDaysAfterClose,
} from "@/lib/projectStatus";
import { ALICE, BOB, CAROL, person, resetDb, validBrief } from "./helpers";

beforeEach(resetDb);

async function project() {
  const r = await createProject(validBrief(), person(ALICE)); // ALICE requests, BOB is tagged
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const [p] = await db.query<{ id: number; code: string }>("SELECT id, code FROM projects WHERE id = $1", [r.id]);
  return p;
}
const as = (id: string) => ({ id, name: person(id).name });
const row = async (id: number) =>
  (await db.query<{ status: string; closed_at: string | null }>("SELECT status, closed_at FROM projects WHERE id = $1", [id]))[0];

let n = 0;
async function inbound(projectId: number | null, status = "Matched") {
  n++;
  const [m] = await db.query<{ id: number }>(
    `INSERT INTO inbound_messages (graph_id, received_at, subject, body, status, project_id, created_at)
     VALUES ($1,$2,'s','body text',$3,$4,$5) RETURNING id`,
    [`g${n}`, new Date().toISOString(), status, projectId, new Date().toISOString()],
  );
  return m.id;
}
const retain = async (id: number) =>
  (await db.query<{ retain_until: string | null; body: string; purged_at: string | null }>(
    "SELECT retain_until, body, purged_at FROM inbound_messages WHERE id = $1",
    [id],
  ))[0];

describe("states", () => {
  it("starts as Just opened", async () => {
    const p = await project();
    expect((await row(p.id)).status).toBe("Just opened");
  });

  it("lists the moves allowed from each state", () => {
    expect(nextStatuses("Just opened")).toEqual(["Ongoing", "Closed"]);
    expect(nextStatuses("Ongoing")).toEqual(["Compliance", "Closed"]);
    expect(nextStatuses("Compliance")).toEqual(["Ongoing", "Closed"]);
    expect(nextStatuses("Closed")).toEqual([]);
    expect(nextStatuses("nonsense")).toEqual([]);
  });

  it("moves through the states and logs who did it", async () => {
    const p = await project();
    expect(await changeProjectStatus(p.id, as(BOB), "Ongoing")).toEqual({ ok: true, status: "Ongoing" });
    expect(await changeProjectStatus(p.id, as(ALICE), "Compliance")).toMatchObject({ ok: true });
    expect(await changeProjectStatus(p.id, as(BOB), "Ongoing")).toMatchObject({ ok: true }); // sent back
    const log = await db.query<{ from_status: string; to_status: string; user_id: string }>(
      "SELECT from_status, to_status, user_id FROM project_status_log WHERE project_id = $1 ORDER BY id",
      [p.id],
    );
    expect(log.map((l) => [l.from_status, l.to_status, l.user_id])).toEqual([
      ["Just opened", "Ongoing", BOB],
      ["Ongoing", "Compliance", ALICE],
      ["Compliance", "Ongoing", BOB],
    ]);
  });

  it("refuses a move that is not allowed, and an unknown status", async () => {
    const p = await project();
    expect(await changeProjectStatus(p.id, as(ALICE), "Compliance")).toMatchObject({ ok: false, code: "not_allowed" });
    expect(await changeProjectStatus(p.id, as(ALICE), "Done")).toMatchObject({ ok: false, code: "invalid" });
    expect(await changeProjectStatus(p.id, as(ALICE), undefined)).toMatchObject({ ok: false, code: "invalid" });
    expect((await row(p.id)).status).toBe("Just opened");
    expect((await db.query("SELECT 1 FROM project_status_log")).length).toBe(0);
  });

  it("hides the project from someone who is not a member", async () => {
    const p = await project();
    expect(await changeProjectStatus(p.id, as(CAROL), "Ongoing")).toMatchObject({ ok: false, code: "not_found" });
    expect(await changeProjectStatus(99999, as(ALICE), "Ongoing")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("lets only the requester close a project", async () => {
    const p = await project();
    expect(await changeProjectStatus(p.id, as(BOB), "Closed")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await row(p.id)).status).toBe("Just opened");
    expect(await changeProjectStatus(p.id, as(ALICE), "Closed")).toMatchObject({ ok: true });
  });

  it("does not reopen a closed project", async () => {
    const p = await project();
    await changeProjectStatus(p.id, as(ALICE), "Closed");
    expect(await changeProjectStatus(p.id, as(ALICE), "Ongoing")).toMatchObject({ ok: false, code: "not_allowed" });
  });
});

describe("closing and retention", () => {
  it("sets closed_at and starts the retention clock for the project's mail, and only that", async () => {
    const p = await project();
    const other = await project();
    const mine = await inbound(p.id);
    const theirs = await inbound(other.id);
    const unmatched = await inbound(null, "Unmatched");
    await changeProjectStatus(p.id, as(ALICE), "Closed", { RETENTION_DAYS_AFTER_CLOSE: "30" });
    const closedAt = (await row(p.id)).closed_at!;
    expect(closedAt).not.toBeNull();
    expect((await retain(mine)).retain_until).toBe(retainUntilAfterClose(closedAt, 30));
    expect((await retain(theirs)).retain_until).toBeNull();
    expect((await retain(unmatched)).retain_until).toBeNull();
  });

  it("makes mail due straight away when no days are configured", async () => {
    const p = await project();
    const m = await inbound(p.id);
    await changeProjectStatus(p.id, as(ALICE), "Closed", {});
    expect((await retain(m)).retain_until).toBe((await row(p.id)).closed_at);
  });

  it("gives mail that arrives after the close the same retention", async () => {
    const p = await project();
    await changeProjectStatus(p.id, as(ALICE), "Closed", {});
    await db.query(
      `INSERT INTO inbound_messages (graph_id, received_at, from_address, subject, status, created_at)
       VALUES ('late', $1, 'intake1@vendor.test', $2, 'Received', $1)`,
      [new Date().toISOString(), `Re: [${p.code}] late`],
    );
    await matchPending();
    const [m] = await db.query<{ status: string; retain_until: string | null }>(
      "SELECT status, retain_until FROM inbound_messages WHERE graph_id = 'late'",
    );
    expect(m.status).toBe("Matched");
    expect(m.retain_until).toBe((await row(p.id)).closed_at);
  });

  it("purges a closed project's mail, and nothing else, only when asked", async () => {
    const p = await project();
    const open = await project();
    const mine = await inbound(p.id);
    const theirs = await inbound(open.id);
    await changeProjectStatus(p.id, as(ALICE), "Closed", {});
    expect((await retain(mine)).body).toBe("body text"); // closing alone deletes nothing
    expect(await purgeExpired()).toBe(1);
    expect(await retain(mine)).toMatchObject({ body: "" });
    expect((await retain(mine)).purged_at).not.toBeNull();
    expect(await retain(theirs)).toMatchObject({ body: "body text", purged_at: null });
  });
});

describe("retention setting", () => {
  it("defaults to 0 days and reads a whole number", () => {
    expect(retentionDaysAfterClose({})).toBe(0);
    expect(retentionDaysAfterClose({ RETENTION_DAYS_AFTER_CLOSE: " " })).toBe(0);
    expect(retentionDaysAfterClose({ RETENTION_DAYS_AFTER_CLOSE: "90" })).toBe(90);
  });
  it("refuses anything else instead of guessing", () => {
    for (const bad of ["abc", "-1", "1.5", "99999"]) {
      expect(() => retentionDaysAfterClose({ RETENTION_DAYS_AFTER_CLOSE: bad })).toThrow(/whole number/);
    }
  });
});
