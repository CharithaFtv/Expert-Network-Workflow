import { describe, expect, it } from "vitest";
import { authMode, entraConfig, sessionSecret } from "@/lib/auth/config";
import { authorizeUrl, emailFromClaims, newLoginAttempt, validateIdToken } from "@/lib/auth/entra";
import { signToken, verifyToken } from "@/lib/auth/token";
import { getUserByEmail } from "@/lib/dealcloud";

const SECRET = "x".repeat(40);
const cfg = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "s", redirectUri: "http://localhost:3000/api/auth/callback" };

const idToken = (over: Record<string, unknown> = {}) => {
  const claims = {
    iss: "https://login.microsoftonline.com/tenant-1/v2.0",
    aud: "client-1",
    tid: "tenant-1",
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: "n1",
    preferred_username: "Alice@ftvcapital.com",
    ...over,
  };
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
};

describe("signed session tokens", () => {
  it("round-trips and rejects tampering, wrong secret and expiry", async () => {
    const t = await signToken({ uid: "u1" }, SECRET, 60);
    expect(await verifyToken<{ uid: string }>(t, SECRET)).toMatchObject({ uid: "u1" });
    const [body, mac] = t.split(".");
    const forged = `${Buffer.from(JSON.stringify({ uid: "u2", exp: 9999999999 })).toString("base64url")}.${mac}`;
    expect(await verifyToken(forged, SECRET)).toBeNull();
    expect(await verifyToken(`${body}.${mac.slice(0, -2)}AA`, SECRET)).toBeNull();
    expect(await verifyToken(t, "y".repeat(40))).toBeNull();
    expect(await verifyToken(await signToken({ uid: "u1" }, SECRET, -1), SECRET)).toBeNull();
    expect(await verifyToken(undefined, SECRET)).toBeNull();
    expect(await verifyToken("garbage", SECRET)).toBeNull();
  });
});

describe("Entra id_token validation", () => {
  it("accepts a good token and reads the email", () => {
    expect(emailFromClaims(validateIdToken(idToken(), cfg, "n1"))).toBe("alice@ftvcapital.com");
  });
  it.each([
    ["issuer", { iss: "https://login.microsoftonline.com/other/v2.0" }],
    ["tenant", { tid: "other" }],
    ["audience", { aud: "other-app" }],
    ["expired", { exp: Math.floor(Date.now() / 1000) - 5 }],
    ["nonce", { nonce: "wrong" }],
  ])("rejects a bad %s", (_n, over) => {
    expect(() => validateIdToken(idToken(over), cfg, "n1")).toThrow();
  });
  it("builds a PKCE authorize URL for the tenant", async () => {
    const a = await newLoginAttempt();
    const u = new URL(authorizeUrl(cfg, a));
    expect(u.pathname).toBe("/tenant-1/oauth2/v2.0/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(u.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
  });
});

describe("directory mapping", () => {
  it("maps a Microsoft email to the FTV user, case-insensitively; others get nothing", () => {
    expect(getUserByEmail("ALICE@ftvcapital.com")?.name).toBe("Alice Associate");
    expect(getUserByEmail("support@prosapient.com")).toBeUndefined();
    expect(getUserByEmail("nobody@ftvcapital.com")).toBeUndefined();
  });
});

describe("auth config", () => {
  it("defaults to entra, refuses dev in production, and requires a real secret", () => {
    expect(authMode({})).toBe("entra");
    expect(() => authMode({ AUTH_MODE: "dev", NODE_ENV: "production" })).toThrow();
    expect(() => authMode({ AUTH_MODE: "nope" })).toThrow();
    expect(() => sessionSecret({})).toThrow(/SESSION_SECRET/);
    expect(sessionSecret({ SESSION_SECRET: SECRET })).toBe(SECRET);
  });
  it("falls back to the Graph app registration for sign-in", () => {
    const c = entraConfig({ GRAPH_TENANT_ID: "t", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s", APP_URL: "https://app.x/" });
    expect(c).toMatchObject({ tenantId: "t", clientId: "c", redirectUri: "https://app.x/api/auth/callback" });
    expect(entraConfig({})).toBeUndefined();
  });
});
