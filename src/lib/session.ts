import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, SESSION_HOURS, sessionSecret } from "./auth/config";
import { signToken, verifyToken } from "./auth/token";
import { getUser } from "./dealcloud";
import type { Person } from "./types";

export { SESSION_COOKIE };

/**
 * The session is a signed, expiring cookie holding the DealCloud user id. It is only ever set
 * after Microsoft sign-in (AUTH_MODE=entra) or, locally, the dev picker (AUTH_MODE=dev).
 */
export async function startSession(userId: string) {
  const token = await signToken({ uid: userId }, sessionSecret(), SESSION_HOURS * 3600);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function currentUser(): Promise<Person | undefined> {
  const payload = await verifyToken<{ uid: string }>((await cookies()).get(SESSION_COOKIE)?.value, sessionSecret());
  return payload ? getUser(payload.uid) : undefined;
}

export async function requireUser(): Promise<Person> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
