import Link from "next/link";
import { listProjectsFor } from "@/lib/projects";
import { requireUser } from "@/lib/session";

export default async function ProjectsPage() {
  const user = await requireUser();
  const projects = await listProjectsFor(user.id);
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Expert network</p>
          <h1>Your projects</h1>
          <div className="rule" />
        </div>
        <Link className="btn" href="/projects/new">
          New request
        </Link>
      </div>
      <div className="card">
        {projects.length === 0 ? (
          <div className="empty-state">
            <h2>No projects yet</h2>
            <p className="muted">
              Projects you start, and projects you are tagged on, appear here.
            </p>
            <Link className="btn" href="/projects/new">
              Start an expert network request
            </Link>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="list">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>DealCloud deal</th>
                  <th>Requester</th>
                  <th>Status</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/projects/${p.id}`}>
                        <strong>{p.title}</strong>
                      </Link>
                      <div className="small muted">{p.code}</div>
                    </td>
                    <td>
                      {p.deal_name}{" "}
                      <span className={`tag ${p.deal_status.toLowerCase()}`}>{p.deal_status}</span>
                    </td>
                    <td>{p.requester_name}</td>
                    <td>
                      <span className="tag blue">{p.status}</span>
                    </td>
                    <td className="muted">{p.created_at.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}
