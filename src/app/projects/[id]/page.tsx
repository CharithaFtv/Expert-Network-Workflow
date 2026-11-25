import Link from "next/link";
import { notFound } from "next/navigation";
import { getUser } from "@/lib/dealcloud";
import { buildNetworkBrief, getProjectFor } from "@/lib/projects";
import { ProjectStatusControl } from "@/components/ProjectStatusControl";
import { nextStatuses } from "@/lib/projectStatus";
import { requireUser } from "@/lib/session";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const data = /^\d+$/.test(id) ? await getProjectFor(Number(id), user.id) : undefined;
  if (!data) notFound();
  const { project, members, vendors, brief } = data;
  const requester = getUser(project.requester_id);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">{project.code}</p>
          <h1>{project.title}</h1>
          <div className="rule" />
        </div>
        <span className="tag blue">{project.status}</span>
      </div>

      <div className="grid-2">
        <div>
          <section className="card accent stack">
            <h2>Brief</h2>
            <p style={{ whiteSpace: "pre-wrap" }}>{brief.objective}</p>
            <dl className="kv">
              <dt>Target company</dt>
              <dd>{brief.targetCompanies.join(", ")}</dd>
              <dt>Competitors</dt>
              <dd>{brief.competitors.join(", ") || "None listed"}</dd>
              <dt>Expert profiles</dt>
              <dd>
                {brief.expertTypes.join(", ")}
              </dd>
              <dt>Calls requested</dt>
              <dd>{brief.callsTarget}</dd>
              <dt>Window</dt>
              <dd>
                {brief.startDate} to {brief.endDate}
              </dd>
            </dl>
            {brief.targetLogos.length > 0 && (
              <div>
                <p className="label">Organisations to source from</p>
                <div className="inline">
                  {brief.targetLogos.map((l) => (
                    <span key={l} className="tag">
                      {l}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="card stack">
            <h2>Screener</h2>
            {brief.screener.length ? (
              <ol className="plain">
                {brief.screener.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ol>
            ) : (
              <p className="muted">No screener questions supplied.</p>
            )}
          </section>

          {(brief.complianceNotes || brief.additionalNotes) && (
            <section className="card stack">
              <h2>Notes</h2>
              {brief.complianceNotes && (
                <div>
                  <p className="label">Compliance and exclusions</p>
                  <p style={{ whiteSpace: "pre-wrap" }}>{brief.complianceNotes}</p>
                </div>
              )}
              {brief.additionalNotes && (
                <div>
                  <p className="label">Additional notes for the network</p>
                  <p style={{ whiteSpace: "pre-wrap" }}>{brief.additionalNotes}</p>
                </div>
              )}
            </section>
          )}

          {requester && (
            <section className="card stack">
              <h2>Message to the network</h2>
              <p className="hint">
                Queued, not yet sent. The DealCloud deal link stays internal and is not included.
              </p>
              <pre className="brief">{buildNetworkBrief(brief, requester)}</pre>
            </section>
          )}
        </div>

        <aside>
          <section className="card tint stack">
            <p className="eyebrow">DealCloud deal</p>
            <div className="deal">
              <div className="name">{project.deal_name}</div>
              <span className={`tag ${project.deal_status.toLowerCase()}`}>
                {project.deal_status}
              </span>
            </div>
            <dl className="kv" style={{ gridTemplateColumns: "80px 1fr" }}>
              <dt>Company</dt>
              <dd>{project.company_name}</dd>
              <dt>Sector</dt>
              <dd>{project.sector || "Not set"}</dd>
            </dl>
            <p className="hint">Deal status as recorded in DealCloud when the request was submitted.</p>
          </section>

          <section className="card stack">
            <h2>Project status</h2>
            <div>
              <span className="tag blue">{project.status}</span>
            </div>
            <ProjectStatusControl
              key={project.status}
              projectId={project.id}
              options={[...nextStatuses(project.status)]}
              canClose={project.requester_id === user.id}
            />
            <p className="hint">
              Closing starts the retention clock for the emails and attachments received on this project.
            </p>
          </section>

          <section className="card stack">
            <h2>Team</h2>
            {members.map((m) => (
              <div key={m.user_id}>
                <strong>{m.user_name}</strong>
                <div className="small muted">
                  {m.role === "Requester" ? "Requester" : "Tagged and notified"}
                </div>
              </div>
            ))}
          </section>

          <section className="card stack">
            <h2>Expert networks</h2>
            {vendors.map((v) => (
              <div key={v.name} className="deal">
                <strong>{v.name}</strong>
                <span className="tag">{v.status}</span>
              </div>
            ))}
          </section>

          <Link href="/">Back to projects</Link>
        </aside>
      </div>
    </main>
  );
}
