type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = "enw_session";
export const OAUTH_COOKIE = "enw_oauth";
export const SESSION_HOURS = 8;

/** "entra" (default): Microsoft SSO, the only way in. "dev": name picker, never in production. */
export function authMode(env: Env = process.env): "entra" | "dev" {
  const m = env.AUTH_MODE?.trim() || "entra";
  if (m !== "entra" && m !== "dev") throw new Error(`AUTH_MODE must be "entra" or "dev", got "${m}"`);
  if (m === "dev" && env.NODE_ENV === "production") throw new Error("AUTH_MODE=dev is not allowed in production");
  return m;
}

export function sessionSecret(env: Env = process.env): string {
  const s = env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (authMode(env) === "dev" && env.NODE_ENV !== "production") return "dev-only-session-secret-not-for-real-use";
  throw new Error("SESSION_SECRET must be set to at least 32 characters");
}

export type EntraConfig = { tenantId: string; clientId: string; clientSecret: string; redirectUri: string };

/** Reuses the Graph app registration unless ENTRA_* overrides are given. */
export function entraConfig(env: Env = process.env): EntraConfig | undefined {
  const tenantId = env.ENTRA_TENANT_ID || env.GRAPH_TENANT_ID;
  const clientId = env.ENTRA_CLIENT_ID || env.GRAPH_CLIENT_ID;
  const clientSecret = env.ENTRA_CLIENT_SECRET || env.GRAPH_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) return undefined;
  const appUrl = (env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  return { tenantId, clientId, clientSecret, redirectUri: `${appUrl}/api/auth/callback` };
}
