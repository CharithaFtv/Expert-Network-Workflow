// Signed, expiring tokens (HMAC-SHA256) via Web Crypto, so the same code runs in the proxy and in routes.
const enc = new TextEncoder();

const toB64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret: string, usage: KeyUsage[]) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);

export async function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number) {
  const body = toB64u(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(body));
  return `${body}.${toB64u(new Uint8Array(mac))}`;
}

/** Returns the payload only if the signature is valid and the token has not expired. */
export async function verifyToken<T extends Record<string, unknown>>(
  token: string | undefined,
  secret: string,
): Promise<T | null> {
  if (!token) return null;
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), fromB64u(mac), enc.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64u(body))) as T & { exp?: number };
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function randomToken(bytes = 32) {
  return toB64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256B64u(s: string) {
  return toB64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}
