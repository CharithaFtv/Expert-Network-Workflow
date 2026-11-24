import { randomToken, sha256B64u } from "./token.ts";
import type { EntraConfig } from "./config.ts";

const AUTHORITY = "https://login.microsoftonline.com";

export type Claims = {
  iss?: string;
  aud?: string;
  tid?: string;
  exp?: number;
  nonce?: string;
  preferred_username?: string;
  email?: string;
  upn?: string;
};

/** Fresh state, nonce and PKCE pair for one sign-in attempt. */
export async function newLoginAttempt() {
  const verifier = randomToken(32);
  return { state: randomToken(16), nonce: randomToken(16), verifier, challenge: await sha256B64u(verifier) };
}

export function authorizeUrl(cfg: EntraConfig, a: { state: string; nonce: string; challenge: string }) {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    state: a.state,
    nonce: a.nonce,
    code_challenge: a.challenge,
    code_challenge_method: "S256",
  });
  return `${AUTHORITY}/${cfg.tenantId}/oauth2/v2.0/authorize?${q}`;
}

/** Server-to-server code exchange. Returns the raw id_token. */
export async function exchangeCode(
  cfg: EntraConfig,
  code: string,
  verifier: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchFn(`${AUTHORITY}/${cfg.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: verifier,
      scope: "openid profile email",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error("Token response had no id_token");
  return json.id_token;
}

/**
 * The id_token arrives directly from Microsoft's token endpoint over TLS, which OIDC Core
 * 3.1.3.7 accepts in place of checking its signature. We still check issuer, audience, tenant,
 * expiry and nonce, so a token for another app, tenant or sign-in attempt is rejected.
 */
export function validateIdToken(idToken: string, cfg: EntraConfig, nonce: string, now = Date.now()): Claims {
  const part = idToken.split(".")[1];
  if (!part) throw new Error("Malformed id_token");
  const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Claims;
  if (claims.iss !== `${AUTHORITY}/${cfg.tenantId}/v2.0`) throw new Error("id_token issuer mismatch");
  if (claims.tid !== cfg.tenantId) throw new Error("id_token tenant mismatch");
  if (claims.aud !== cfg.clientId) throw new Error("id_token audience mismatch");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new Error("id_token expired");
  if (!claims.nonce || claims.nonce !== nonce) throw new Error("id_token nonce mismatch");
  return claims;
}

export function emailFromClaims(c: Claims): string | undefined {
  return (c.preferred_username || c.email || c.upn)?.trim().toLowerCase() || undefined;
}
