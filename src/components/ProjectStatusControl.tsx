"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Moves a project to its next state. `options` come from the server, so only allowed moves are offered. */
export function ProjectStatusControl({
  projectId,
  options,
  canClose,
}: {
  projectId: number;
  options: string[];
  canClose: boolean;
}) {
  const router = useRouter();
  const choices = options.filter((o) => o !== "Closed" || canClose);
  const [next, setNext] = useState(choices[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!choices.length) return <p className="hint">This project is closed.</p>;

  async function move() {
    if (
      next === "Closed" &&
      !window.confirm(
        "Close this project? Closing starts the retention clock: the emails and attachments received for it become due for deletion. This cannot be undone.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${projectId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "Could not change the status.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="inline">
        <select value={next} onChange={(e) => setNext(e.target.value)} disabled={busy} aria-label="Move project to">
          {choices.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <button type="button" className="btn" onClick={move} disabled={busy}>
          {busy ? "Saving" : "Move"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
