import { snapshotSyncedAt } from "@/lib/dealcloud";
import { listVendors, localToday } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import InitiationForm from "@/components/InitiationForm";

export default async function NewProjectPage() {
  const user = await requireUser();
  return (
    <main className="page narrow">
      <div className="page-head">
        <div>
          <p className="eyebrow">Project initiation</p>
          <h1>New expert network request</h1>
          <div className="rule" />
        </div>
      </div>
      <InitiationForm
        requester={user}
        vendors={await listVendors()}
        today={localToday()}
        dealsSyncedAt={snapshotSyncedAt().toISOString().slice(0, 10)}
      />
    </main>
  );
}
