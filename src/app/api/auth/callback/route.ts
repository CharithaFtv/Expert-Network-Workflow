import { NextResponse } from "next/server";
import { OAUTH_COOKIE, SESSION_COOKIE, SESSION_HOURS, entraConfig, sessionSecret } from "@/lib/auth/config";
import { emailFromClaims, exchangeCode, validateIdToken } from "@/lib/auth/entra";
import { signToken, verifyToken } from "@/lib/auth/token";
import { getUserByEmail } from "@/lib/dealcloud";

const back = (req: Request, error: string) => {
  const res = NextResponse.redirect(new URL(`/login?error=${error}`, req.url));
  res.cookies.delete(OAUTH_COOKIE);
  return res;
};

export async function GET(req: Request) {
  const cfg = entraConfig();
  if (!cfg) return back(req, "not-configured");
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code || !state) return back(req, "sign-in-failed");

  const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${OAUTH_COOKIE}=([^;]+)`))?.[1];
  const attempt = await verifyToken<{ s: string; n: string; v: string }>(cookie, sessionSecret());
  if (!attempt || attempt.s !== state) return back(req, "sign-in-failed");

  let email: string | undefined;
  try {
    const claims = validateIdToken(await exchangeCode(cfg, code, attempt.v), cfg, attempt.n);
    email = emailFromClaims(claims);
  } catch {
    return back(req, "sign-in-failed");
  }
  const user = email ? getUserByEmail(email) : undefined;
  if (!user) return back(req, "not-authorized");

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.delete(OAUTH_COOKIE);
  res.cookies.set(SESSION_COOKIE, await signToken({ uid: user.id }, sessionSecret(), SESSION_HOURS * 3600), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_HOURS * 3600,
  });
  return res;
}
