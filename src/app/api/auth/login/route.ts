import { NextResponse } from "next/server";
import { OAUTH_COOKIE, authMode, entraConfig, sessionSecret } from "@/lib/auth/config";
import { authorizeUrl, newLoginAttempt } from "@/lib/auth/entra";
import { signToken } from "@/lib/auth/token";

export async function GET(req: Request) {
  const cfg = entraConfig();
  if (authMode() !== "entra" || !cfg) return NextResponse.redirect(new URL("/login", req.url));
  const a = await newLoginAttempt();
  const res = NextResponse.redirect(authorizeUrl(cfg, a));
  // State, nonce and PKCE verifier live in a short-lived signed cookie, checked on return.
  res.cookies.set(OAUTH_COOKIE, await signToken({ s: a.state, n: a.nonce, v: a.verifier }, sessionSecret(), 600), {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/auth",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
  });
  return res;
}
