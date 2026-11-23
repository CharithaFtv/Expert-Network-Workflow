import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUser } from "./dealcloud";
import type { Person } from "./types";

/**
 * DEVELOPMENT SIGN-IN ONLY. The cookie holds a DealCloud user id chosen on the
 * /login page and is not authenticated. Replace with Microsoft Entra SSO before
 * any shared deployment; map the Entra email to DIM_USER.EMAIL to keep the same
 * Person identity.
 */
export const SESSION_COOKIE = "enw_user";

export async function currentUser(): Promise<Person | undefined> {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  return id ? getUser(id) : undefined;
}

export async function requireUser(): Promise<Person> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
