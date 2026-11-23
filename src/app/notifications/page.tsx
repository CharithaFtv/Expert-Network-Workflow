import Link from "next/link";
import { revalidatePath } from "next/cache";
import { listNotifications, markAllRead } from "@/lib/projects";
import { requireUser } from "@/lib/session";

async function markRead() {
  "use server";
  const user = await requireUser();
  await markAllRead(user.id);
  revalidatePath("/", "layout");
}

export default async function NotificationsPage() {
  const user = await requireUser();
  const notes = await listNotifications(user.id);
  const hasUnread = notes.some((n) => !n.read_at);
  return (
    <main className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">Expert network</p>
          <h1>Notifications</h1>
          <div className="rule" />
        </div>
        {hasUnread && (
          <form action={markRead}>
            <button className="btn secondary sm" type="submit">
              Mark all read
            </button>
          </form>
        )}
      </div>
      <div className="card">
        {notes.length === 0 ? (
          <div className="empty-state">
            <h2>Nothing yet</h2>
            <p className="muted">You will be notified here when someone tags you on a project.</p>
          </div>
        ) : (
          notes.map((n) => (
            <div key={n.id} className={`note ${n.read_at ? "" : "unread"}`}>
              <div>
                {n.project_id ? <Link href={`/projects/${n.project_id}`}>{n.message}</Link> : n.message}
              </div>
              <div className="small muted">{n.created_at.slice(0, 10)}</div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
