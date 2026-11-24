import { redirect } from "next/navigation";
import { authMode, entraConfig } from "@/lib/auth/config";
import { getUser, listUsers } from "@/lib/dealcloud";
import { startSession } from "@/lib/session";

async function devSignIn(formData: FormData) {
  "use server";
  if (authMode() !== "dev") redirect("/login");
  const id = String(formData.get("userId") ?? "");
  if (!getUser(id)) redirect("/login");
  await startSession(id);
  redirect("/");
}

const MESSAGES: Record<string, string> = {
  "not-authorized": "Your Microsoft account is not in the FTV user directory, so you have no access. Contact the Technology team if this is wrong.",
  "sign-in-failed": "Sign-in did not complete. Please try again.",
  "not-configured": "Microsoft sign-in is not configured for this environment.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; signedout?: string }>;
}) {
  const { error, signedout } = await searchParams;

  if (authMode() === "entra") {
    // Normal case: straight to Microsoft. With the browser already signed in to FTV, the user
    // lands in the app as themselves with no clicks and no choice.
    if (!entraConfig()) {
      return <Card title="Sign-in unavailable" message={MESSAGES["not-configured"]} />;
    }
    if (!error && !signedout) redirect("/api/auth/login");
    return (
      <Card
        title={signedout ? "You have signed out" : "Sign-in problem"}
        message={error ? (MESSAGES[error] ?? MESSAGES["sign-in-failed"]) : undefined}
        action
      />
    );
  }

  const users = listUsers();
  return (
    <main className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">Development sign-in (AUTH_MODE=dev)</p>
          <h1>Choose who you are</h1>
          <div className="rule" />
        </div>
      </div>
      <form action={devSignIn} className="card accent">
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
          <p className="hint">Local development only. Real deployments use Microsoft single sign-on.</p>
        </div>
        <button className="btn" type="submit">
          Continue
        </button>
      </form>
    </main>
  );
}

function Card({ title, message, action }: { title: string; message?: string; action?: boolean }) {
  return (
    <main className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">FTV Capital</p>
          <h1>{title}</h1>
          <div className="rule" />
        </div>
      </div>
      <div className="card accent">
        {message && <p>{message}</p>}
        {action && (
          <a className="btn" href="/api/auth/login">
            Sign in with Microsoft
          </a>
        )}
      </div>
    </main>
  );
}
