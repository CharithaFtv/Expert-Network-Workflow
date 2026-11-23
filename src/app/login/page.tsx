import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getUser, listUsers } from "@/lib/dealcloud";
import { SESSION_COOKIE } from "@/lib/session";

async function signIn(formData: FormData) {
  "use server";
  const id = String(formData.get("userId") ?? "");
  if (!getUser(id)) redirect("/login");
  (await cookies()).set(SESSION_COOKIE, id, { httpOnly: true, sameSite: "lax", path: "/" });
  redirect("/");
}

export default function LoginPage() {
  const users = listUsers();
  return (
    <main className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">Development sign-in</p>
          <h1>Choose who you are</h1>
          <div className="rule" />
        </div>
      </div>
      <form action={signIn} className="card accent">
        <div className="field">
          <label htmlFor="userId">FTV user</label>
          <select id="userId" name="userId" required defaultValue="">
            <option value="" disabled>
              Select your name
            </option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({[u.title, u.team].filter(Boolean).join(", ")})
              </option>
            ))}
          </select>
          <p className="hint">
            Names come from the DealCloud user directory. This picker stands in for Microsoft
            single sign-on and is for local development only.
          </p>
        </div>
        <button className="btn" type="submit">
          Continue
        </button>
      </form>
    </main>
  );
}
