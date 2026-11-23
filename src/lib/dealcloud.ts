import fs from "node:fs";
import path from "node:path";
import { ELIGIBLE_DEAL_STATUSES, type Deal, type Person } from "./types";

/**
 * DealCloud access layer.
 *
 * Source of truth is the DealCloud warehouse (Snowflake, PROD.SILVER). This
 * build reads a CSV snapshot of the two queries below from data/dealcloud/.
 * To go live, replace `load()` with a Snowflake call running the same SQL;
 * nothing else in the app touches the storage format.
 */
export const DEALS_SQL = `
SELECT ID, NAME, STATUS, STAGE, COMPANY_ID, COMPANY_NAME, SECTOR_NAME,
       SUBSECTOR_NAME, TO_JSON(DEAL_TEAM) AS DEAL_TEAM_JSON
FROM PROD.SILVER.DIM_DEAL
WHERE STATUS IN ('Active','Lead')`;

export const USERS_SQL = `
SELECT ID, NAME, EMAIL, TITLE, FTV_TEAM_NAME, INITIALS, OFFICE_LOCATION
FROM PROD.SILVER.DIM_USER
WHERE IS_ACTIVE = TRUE`;

const SNAPSHOT_DIR =
  process.env.DEALCLOUD_SNAPSHOT_DIR ?? path.join(process.cwd(), "data", "dealcloud");

/** RFC 4180 parser: handles quoted fields, doubled quotes, embedded commas/newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const isId = (s: string | undefined) => !!s && /^[0-9a-f]{32}$/.test(s);

type Snapshot = {
  deals: Deal[];
  dealsById: Map<string, Deal>;
  users: Person[];
  usersById: Map<string, Person>;
  syncedAt: Date;
  stamp: string;
};

let cache: Snapshot | null = null;

function load(): Snapshot {
  const dealsPath = path.join(SNAPSHOT_DIR, "deals.csv");
  const usersPath = path.join(SNAPSHOT_DIR, "users.csv");
  const dStat = fs.statSync(dealsPath);
  const uStat = fs.statSync(usersPath);
  const stamp = `${dStat.mtimeMs}:${uStat.mtimeMs}`;
  if (cache && cache.stamp === stamp) return cache;

  // Directory: real FTV staff only (drops vendor support and test accounts).
  const users: Person[] = parseCsv(fs.readFileSync(usersPath, "utf8"))
    .filter((r) => isId(r[0]) && /@ftvcapital\.com$/i.test(r[2] ?? "") && r[4])
    .map((r) => ({
      id: r[0],
      name: r[1],
      email: r[2].toLowerCase(),
      title: r[3] ?? "",
      team: r[4] ?? "",
      office: r[6] ?? "",
    }));
  const usersById = new Map(users.map((u) => [u.id, u]));

  const deals: Deal[] = parseCsv(fs.readFileSync(dealsPath, "utf8"))
    .filter((r) => isId(r[0]))
    .map((r) => {
      let team: { ID: string }[] = [];
      try {
        team = JSON.parse(r[8] || "[]") ?? [];
      } catch {
        team = [];
      }
      return {
        id: r[0],
        name: r[1],
        status: r[2],
        stage: r[3] ?? "",
        companyName: r[5] ?? "",
        sector: r[6] ?? "",
        subsector: r[7] ?? "",
        dealTeam: team
          .map((m) => usersById.get(m.ID))
          .filter((u): u is Person => !!u),
      };
    });

  cache = {
    deals,
    dealsById: new Map(deals.map((d) => [d.id, d])),
    users,
    usersById,
    syncedAt: new Date(Math.min(dStat.mtimeMs, uStat.mtimeMs)),
    stamp,
  };
  return cache;
}

export function isEligibleDeal(deal: Deal | undefined): deal is Deal {
  return !!deal && (ELIGIBLE_DEAL_STATUSES as readonly string[]).includes(deal.status);
}

export function getDeal(id: string): Deal | undefined {
  return load().dealsById.get(id);
}

/** Eligible (Active or Lead) deals. The caller's own deals first, then Active, then Lead. */
export function searchDeals(q: string, forUserId?: string, limit = 20): Deal[] {
  const needle = q.trim().toLowerCase();
  const rank = (d: Deal) =>
    (forUserId && d.dealTeam.some((m) => m.id === forUserId) ? 0 : 2) +
    (d.status === "Active" ? 0 : 1);
  return load()
    .deals.filter(isEligibleDeal)
    .filter(
      (d) =>
        !needle ||
        d.name.toLowerCase().includes(needle) ||
        d.companyName.toLowerCase().includes(needle),
    )
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export function getUser(id: string): Person | undefined {
  return load().usersById.get(id);
}

export function listUsers(): Person[] {
  return load().users;
}

export function searchUsers(q: string, limit = 8): Person[] {
  const needle = q.trim().replace(/^@/, "").toLowerCase();
  if (!needle) return [];
  const score = (u: Person) => {
    const n = u.name.toLowerCase();
    if (n.startsWith(needle)) return 0;
    if (n.split(/\s+/).some((p) => p.startsWith(needle))) return 1;
    if (n.includes(needle) || u.email.startsWith(needle)) return 2;
    return 9;
  };
  return load()
    .users.map((u) => ({ u, s: score(u) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.u.name.localeCompare(b.u.name))
    .slice(0, limit)
    .map((x) => x.u);
}

export function snapshotSyncedAt(): Date {
  return load().syncedAt;
}
