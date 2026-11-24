import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  buildNetworkBrief,
  createProject,
  getProjectFor,
  listNotifications,
  listProjectsFor,
  markAllRead,
  unreadCount,
  validateBrief,
} from "@/lib/projects";
import { ALICE, BOB, CAROL, DEAL_PASSED, person, resetDb, validBrief } from "./helpers";

beforeEach(resetDb);

const create = (over = {}, who = ALICE) => createProject(validBrief(over), person(who));
const count = async (table: string) =>
  (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n;

async function created(over = {}) {
  const r = await create(over);
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.errors)}`);
  return r.id;
}

describe("createProject", () => {
  it("creates a project with code, requester membership and tagged members", async () => {
    const id = await created();
    const view = (await getProjectFor(id, ALICE))!;
    expect(view.project.code).toMatch(/^EN-\d{4}-0001$/);
    expect(view.project.status).toBe("Submitted");
    expect(view.members.map((m) => [m.user_id, m.role]).sort()).toEqual([
      [ALICE, "Requester"],
      [BOB, "Team"],
    ]);
    expect(view.vendors.map((v) => v.name)).toEqual(["proSapient"]);
    expect(view.vendors[0].status).toBe("Pending send");
  });

  it("snapshots the deal's identity on the project", async () => {
    const p = (await getProjectFor(await created(), ALICE))!.project;
    expect([p.deal_name, p.deal_status, p.requester_id]).toEqual(["Zeta Active", "Active", ALICE]);
  });

  it("rejects an ineligible deal and writes nothing", async () => {
    const r = await create({ dealId: DEAL_PASSED });
    expect(r.ok).toBe(false);
    expect(await count("projects")).toBe(0);
    expect(await count("outbox")).toBe(0);
  });

  it("rolls back everything if any step fails mid-way", async () => {
    // A tagged user the directory knows but with a vendor row that disappears mid-flight is
    // hard to stage; instead force a failure with a duplicate vendor id in the DB constraint.
    await db.query("ALTER TABLE outbox ADD CONSTRAINT t_fail CHECK (kind <> 'network-brief')");
    try {
      await expect(create()).rejects.toThrow();
      expect(await count("projects")).toBe(0);
      expect(await count("project_members")).toBe(0);
      expect(await count("notifications")).toBe(0);
    } finally {
      await db.query("ALTER TABLE outbox DROP CONSTRAINT t_fail");
    }
  });

  it("refuses a vendor with no intake email and saves nothing", async () => {
    await db.query("UPDATE vendors SET intake_email = NULL WHERE id = 1");
    await expect(create()).rejects.toThrow(/no intake email/);
    expect(await count("projects")).toBe(0);
    expect(await count("outbox")).toBe(0);
  });

  it("tags the vendor brief subject with the project code so replies can be matched", async () => {
    const id = await created();
    const [row] = await db.query<{ subject: string }>("SELECT subject FROM outbox WHERE kind = 'network-brief'");
    const view = (await getProjectFor(id, ALICE))!;
    expect(row.subject).toBe(`[${view.project.code}] Wholesale distributor software`);
  });

  it("notifies each tagged person but not the requester", async () => {
    await created();
    expect(await listNotifications(BOB)).toHaveLength(1);
    expect((await listNotifications(BOB))[0].message).toContain("Alice Associate tagged you");
    expect(await listNotifications(ALICE)).toHaveLength(0);
  });

  it("queues one network brief per vendor and one email per tagged person", async () => {
    await created({ vendorIds: [1, 2] });
    const rows = await db.query<{ kind: string }>("SELECT kind FROM outbox");
    expect(rows.filter((r) => r.kind === "network-brief")).toHaveLength(2);
    expect(rows.filter((r) => r.kind === "team-notification")).toHaveLength(1);
  });

  it("never puts the internal deal name in a network brief", async () => {
    await created();
    const rows = await db.query<{ body: string; subject: string }>(
      "SELECT body, subject FROM outbox WHERE kind = 'network-brief'",
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.body + r.subject).not.toMatch(/Zeta/);
  });

  it("assigns sequential codes", async () => {
    await created();
    const id2 = await created();
    expect((await getProjectFor(id2, ALICE))!.project.code).toMatch(/-0002$/);
  });
});

describe("access control", () => {
  it("lets only members see a project", async () => {
    const id = await created();
    expect(await getProjectFor(id, ALICE)).toBeDefined();
    expect(await getProjectFor(id, BOB)).toBeDefined();
    expect(await getProjectFor(id, CAROL)).toBeUndefined();
    expect(await listProjectsFor(CAROL)).toEqual([]);
    expect(await listProjectsFor(BOB)).toHaveLength(1);
  });
});

describe("notifications", () => {
  it("counts and clears unread", async () => {
    await created();
    expect(await unreadCount(BOB)).toBe(1);
    await markAllRead(BOB);
    expect(await unreadCount(BOB)).toBe(0);
  });
});

describe("buildNetworkBrief", () => {
  it("renders the request and signs as the requester", async () => {
    const { input } = await validateBrief(validBrief(), person(ALICE));
    const text = buildNetworkBrief(input, person(ALICE));
    expect(text).toContain("Target company: Kodaris");
    expect(text).toContain("Known competitors: Suppli");
    expect(text).toContain("key decision makers only");
    expect(text).toContain("Calls requested: 5");
    expect(text).toContain("1. What was your role in the decision?");
    expect(text).toContain("Alice Associate");
    expect(text).not.toContain("Zeta");
  });

  it("omits optional sections when empty", async () => {
    const { input } = await validateBrief(
      validBrief({ competitors: [], screener: [], geography: "", decisionMakerRequired: false }),
      person(ALICE),
    );
    const text = buildNetworkBrief(input, person(ALICE));
    expect(text).not.toContain("Known competitors");
    expect(text).not.toContain("use the screener");
    expect(text).not.toContain("Geography");
    expect(text).not.toContain("decision makers only");
  });
});
