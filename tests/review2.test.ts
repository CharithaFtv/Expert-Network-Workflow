import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { backfillRetention, dueForPurge } from "@/lib/mail/retention";
import { createProject } from "@/lib/projects";
import { changeProjectStatus } from "@/lib/projectStatus";
import { pickNext } from "@/lib/statusChoice";
import { ALICE, person, resetDb, validBrief } from "./helpers";

vi.mock("@/lib/session", async () => ({ currentUser: async () => person(ALICE) }));

beforeEach(resetDb);
afterEach(() => vi.unstubAllEnvs());

async function project() {
  const r = await createProject(validBrief(), person(ALICE));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.id;
}
const as = (id: string) => ({ id, name: person(id).name });

let n = 0;
async function inbound(projectId: number, over: { purged?: boolean } = {}) {
  n++;
  const [m] = await db.query<{ id: number }>(
    `INSERT INTO inbound_messages (graph_id, received_at, subject, body, status, project_id, purged_at, created_at)
     VALUES ($1,$2,'s','body text','Matched',$3,$4,$2) RETURNING id`,
    [`r${n}`, new Date().toISOString(), projectId, over.purged ? new Date().toISOString() : null],
  );
  return m.id;
}
const retain = async (id: number) =>
  (await db.query<{ retain_until: string | null }>("SELECT retain_until FROM inbound_messages WHERE id = $1", [id]))[0]
    .retain_until;

describe("retention backfill", () => {
  it("dates mail on projects closed before a period was set, once a period is set", async () => {
    const closed = await project();
    const open = await project();
    const a = await inbound(closed);
    const b = await inbound(open);
    const purged = await inbound(closed, { purged: true });
    await changeProjectStatus(closed, as(ALICE), "Closed", {}); // no period at close: nothing is dated
    expect(await retain(a)).toBeNull();

    expect(await backfillRetention({})).toBe(0); // still no period: still nothing
    expect(await backfillRetention({ RETENTION_DAYS_AFTER_CLOSE: "30" })).toBe(1);

    const [p] = await db.query<{ closed_at: string }>("SELECT closed_at FROM projects WHERE id = $1", [closed]);
    expect(await retain(a)).toBe(new Date(new Date(p.closed_at).getTime() + 30 * 86_400_000).toISOString());
    expect(await retain(b)).toBeNull(); // open project untouched
    expect(await retain(purged)).toBeNull(); // already purged: untouched
    expect(await backfillRetention({ RETENTION_DAYS_AFTER_CLOSE: "30" })).toBe(0); // idempotent
  });
});

describe("dueForPurge (the dry run)", () => {
  it("counts what a purge would remove, including undated mail on closed projects, and changes nothing", async () => {
    const closed = await project();
    await inbound(closed);
    await inbound(closed);
    await changeProjectStatus(closed, as(ALICE), "Closed", {});
    expect(await dueForPurge(new Date(), {}, true)).toEqual([]); // no period: nothing is due
    const later = new Date(Date.now() + 1000);
    // Undated mail on an already-closed project is NOT counted by default: it is only touched on request.
    expect(await dueForPurge(later, { RETENTION_DAYS_AFTER_CLOSE: "0" })).toEqual([]);
    const due = await dueForPurge(later, { RETENTION_DAYS_AFTER_CLOSE: "0" }, true);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ messages: 2, attachments: 0 });
    const notYet = await dueForPurge(new Date(), { RETENTION_DAYS_AFTER_CLOSE: "30" }, true);
    expect(notYet).toEqual([]); // closed, but 30 days have not passed
    expect((await db.query("SELECT 1 FROM inbound_messages WHERE retain_until IS NOT NULL")).length).toBe(0);
  });

  it("counts mail that already has a retention date, without needing the closed-project option", async () => {
    const closed = await project();
    const m = await inbound(closed);
    await changeProjectStatus(closed, as(ALICE), "Closed", { RETENTION_DAYS_AFTER_CLOSE: "0" }); // dated at close
    expect(await retain(m)).not.toBeNull();
    const due = await dueForPurge(new Date(Date.now() + 1000), {});
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ messages: 1 });
  });
});

describe("pickNext", () => {
  it("keeps a pick that is still on offer and falls back after a move", () => {
    expect(pickNext("Compliance", ["Compliance", "Closed"])).toBe("Compliance");
    expect(pickNext("", ["Ongoing", "Closed"])).toBe("Ongoing");
    // The project just moved to Ongoing: the old pick is no longer offered.
    expect(pickNext("Ongoing", ["Compliance", "Closed"])).toBe("Compliance");
    expect(pickNext("x", [])).toBe("");
  });
});

describe("PATCH /api/projects/[id]/status", () => {
  const call = async (id: string, body: string) => {
    const { PATCH } = await import("@/app/api/projects/[id]/status/route");
    return PATCH(new Request("http://x/api", { method: "PATCH", body }), { params: Promise.resolve({ id }) });
  };

  it("answers a body that is not an object with 400, not a crash", async () => {
    const id = String(await project());
    for (const body of ["null", "[]", '"Ongoing"', "7", "{not json"]) {
      expect((await call(id, body)).status).toBe(400);
    }
  });

  it("still moves a project with a valid body, and reports bad requests clearly", async () => {
    const id = String(await project());
    const ok = await call(id, JSON.stringify({ status: "Ongoing" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: "Ongoing" });
    expect((await call(id, JSON.stringify({ status: "Done" }))).status).toBe(422);
    expect((await call(id, JSON.stringify({ status: "Just opened" }))).status).toBe(409);
    expect((await call("abc", "{}")).status).toBe(404);
  });
});
