import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionSecret } from "@/lib/auth/config";
import { verifyToken } from "@/lib/auth/token";

// Deny by default: everything except the sign-in routes needs a valid signed session.
// Pages and API handlers still re-check the user; this is the first gate, not the only one.
export async function proxy(req: NextRequest) {
  if (await verifyToken(req.cookies.get(SESSION_COOKIE)?.value, sessionSecret())) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return Response.json({ errors: { form: "Sign in to continue." } }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  matcher: ["/((?!login|api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|css)$).*)"],
};
