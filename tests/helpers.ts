import { db } from "@/lib/db";
import { getUser } from "@/lib/dealcloud";
import type { Person } from "@/lib/types";

export const ALICE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
export const BOB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2";
export const CAROL = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3";
export const DEAL_ACTIVE = "d0000000000000000000000000000001";
export const DEAL_LEAD = "d0000000000000000000000000000002";
export const DEAL_PASSED = "d0000000000000000000000000000004";

export const person = (id: string): Person => getUser(id)!;

export function validBrief(over: Record<string, unknown> = {}) {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const end = d.toISOString().slice(0, 10);
  return {
    dealId: DEAL_ACTIVE,
    title: "Wholesale distributor software",
    objective: "Understand why customers chose the vendor over competitors.",
    targetCompanies: ["Kodaris"],
    competitors: ["Suppli"],
    targetLogos: [],
    expertTypes: ["Current customers"],
    screener: ["What was your role in the decision?"],
    callsTarget: 5,
    startDate: "",
    endDate: end,
    vendorIds: [1],
    teamUserIds: [BOB],
    complianceNotes: "",
    additionalNotes: "",
    ...over,
  };
}

export async function resetDb() {
  // Keeps vendors (seeded by migration); restarts ids so project codes are predictable.
  await db.query(
    "TRUNCATE project_status_log, inbound_attachments, inbound_failures, inbound_messages, mailbox_sync, notifications, outbox, project_vendors, project_members, projects RESTART IDENTITY CASCADE",
  );
  await db.query("UPDATE vendors SET intake_email = 'intake' || id || '@vendor.test', domains = '{}', active = 1");
}
