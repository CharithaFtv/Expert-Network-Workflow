// Shared, client-safe types and constants (no Node imports here).

export const ELIGIBLE_DEAL_STATUSES = ["Active", "Lead"] as const;

export const EXPERT_TYPES = [
  "Current customers",
  "Former customers",
  "Former employees",
  "Competitors",
  "Partners / channel",
  "Industry experts",
] as const;

export type Person = {
  id: string;
  name: string;
  email: string;
  title: string;
  team: string;
  office: string;
};

export type Deal = {
  id: string;
  name: string;
  status: string;
  stage: string;
  companyName: string;
  sector: string;
  subsector: string;
  dealTeam: Person[];
};

export type Vendor = { id: number; name: string };

export type BriefInput = {
  dealId: string;
  title: string;
  objective: string;
  targetCompanies: string[];
  competitors: string[];
  targetLogos: string[];
  expertTypes: string[];
  decisionMakerRequired: boolean;
  geography: string;
  screener: string[];
  callsTarget: number;
  startDate: string;
  endDate: string;
  vendorIds: number[];
  teamUserIds: string[];
  complianceNotes: string;
  additionalNotes: string;
};

export type FieldErrors = Partial<Record<keyof BriefInput | "form", string>>;
