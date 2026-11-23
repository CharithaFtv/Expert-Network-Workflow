"use client";

import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  EXPERT_TYPES,
  type BriefInput,
  type Deal,
  type FieldErrors,
  type Person,
  type Vendor,
} from "@/lib/types";

/** Debounced typeahead against one of the search endpoints. */
function useSearch<T>(url: string, q: string, enabled: boolean): T[] {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`${url}?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : []))
        .then(setItems)
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [url, q, enabled]);
  return items;
}

function Field(props: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field ${props.error ? "invalid" : ""}`}>
      <label htmlFor={props.htmlFor}>
        {props.label}
        {props.required && <span className="req">*</span>}
      </label>
      {props.children}
      {props.error ? (
        <p className="error">{props.error}</p>
      ) : (
        props.hint && <p className="hint">{props.hint}</p>
      )}
    </div>
  );
}

function DealPicker({ deal, onChange }: { deal: Deal | null; onChange: (d: Deal | null) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const results = useSearch<Deal>("/api/deals", q, open);

  if (deal) {
    return (
      <div className="card tint" style={{ marginBottom: 0 }}>
        <div className="deal">
          <div>
            <div className="name">{deal.name}</div>
            <div className="small muted">{deal.companyName}</div>
          </div>
          <div className="inline">
            <span className={`tag ${deal.status.toLowerCase()}`}>{deal.status}</span>
            <button type="button" className="btn ghost sm" onClick={() => onChange(null)}>
              Change
            </button>
          </div>
        </div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Stage</dt>
          <dd>{deal.stage || "Not set"}</dd>
          <dt>Sector</dt>
          <dd>{[deal.sector, deal.subsector].filter(Boolean).join(" / ") || "Not set"}</dd>
          <dt>Deal team</dt>
          <dd>{deal.dealTeam.map((m) => m.name).join(", ") || "None recorded"}</dd>
        </dl>
      </div>
    );
  }

  return (
    <div className="combo">
      <input
        id="deal"
        type="text"
        autoComplete="off"
        placeholder="Search by deal or company name"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (open && results[0]) onChange(results[0]);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && (
        <ul className="menu" role="listbox">
          {results.length === 0 && <li className="empty">No Active or Lead deals match.</li>}
          {results.map((d) => (
            <li
              key={d.id}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(d);
                setOpen(false);
              }}
            >
              <div>
                <div className="primary">{d.name}</div>
                <div className="secondary">
                  {[d.companyName, d.stage].filter(Boolean).join(" · ")}
                </div>
              </div>
              <span className={`tag ${d.status.toLowerCase()}`}>{d.status}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PeoplePicker(props: {
  people: Person[];
  excludeId: string;
  onChange: (p: Person[]) => void;
}) {
  const { people, excludeId, onChange } = props;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const term = q.replace(/^@/, "").trim();
  const taken = new Set([excludeId, ...people.map((p) => p.id)]);
  const results = useSearch<Person>("/api/users", term, open && term.length > 0).filter(
    (u) => !taken.has(u.id),
  );
  const add = (p: Person) => {
    onChange([...people, p]);
    setQ("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (term && results[0]) add(results[0]);
    } else if (e.key === "Backspace" && !q && people.length) onChange(people.slice(0, -1));
    else if (e.key === "Escape") setOpen(false);
  };
  return (
    <div className="combo">
      <div className="chips">
        {people.map((p) => (
          <span key={p.id} className="chip person" title={p.email}>
            @{p.name}
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              onClick={() => onChange(people.filter((x) => x.id !== p.id))}
            >
              x
            </button>
          </span>
        ))}
        <input
          id="team"
          type="text"
          autoComplete="off"
          placeholder={people.length ? "Tag another person" : "Type @ and a name"}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
        />
      </div>
      {open && term && (
        <ul className="menu" role="listbox">
          {results.length === 0 && <li className="empty">No active FTV user matches.</li>}
          {results.map((u) => (
            <li
              key={u.id}
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                add(u);
              }}
            >
              <div>
                <div className="primary">{u.name}</div>
                <div className="secondary">
                  {[u.title, u.team, u.office].filter(Boolean).join(" · ")}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Free-text chips. Enter or comma adds; pasting a comma or line separated list adds all. */
function ChipInput(props: {
  id: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const { id, values, onChange, placeholder } = props;
  const [text, setText] = useState("");
  const commit = (raw: string) => {
    const parts = raw
      .split(/[,;\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) onChange([...new Set([...values, ...parts])]);
    setText("");
  };
  return (
    <div className="chips">
      {values.map((v) => (
        <span key={v} className="chip">
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            x
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        autoComplete="off"
        placeholder={values.length ? "" : placeholder}
        value={text}
        onChange={(e) => (/[,;\n]/.test(e.target.value) ? commit(e.target.value) : setText(e.target.value))}
        onBlur={() => commit(text)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (/[,;\n]/.test(pasted)) {
            e.preventDefault();
            commit(text + pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(text);
          } else if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
        }}
      />
    </div>
  );
}

const ERROR_ORDER: (keyof FieldErrors)[] = [
  "form",
  "dealId",
  "teamUserIds",
  "title",
  "objective",
  "targetCompanies",
  "expertTypes",
  "callsTarget",
  "endDate",
  "vendorIds",
];

export default function InitiationForm(props: {
  requester: Person;
  vendors: Vendor[];
  today: string;
  dealsSyncedAt: string;
}) {
  const { requester, vendors, today, dealsSyncedAt } = props;
  const router = useRouter();

  const [deal, setDeal] = useState<Deal | null>(null);
  const [team, setTeam] = useState<Person[]>([]);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [targetCompanies, setTargetCompanies] = useState<string[]>([]);
  const [competitors, setCompetitors] = useState<string[]>([]);
  const [targetLogos, setTargetLogos] = useState<string[]>([]);
  const [expertTypes, setExpertTypes] = useState<string[]>([]);
  const [decisionMakerRequired, setDecisionMakerRequired] = useState(false);
  const [geography, setGeography] = useState("");
  const [screener, setScreener] = useState<string[]>([""]);
  const [callsTarget, setCallsTarget] = useState("5");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState("");
  const [vendorIds, setVendorIds] = useState<number[]>([]);
  const [complianceNotes, setComplianceNotes] = useState("");
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  // Linking a deal pre-fills what DealCloud already knows; everything stays editable.
  const selectDeal = (d: Deal | null) => {
    setDeal(d);
    if (!d) return;
    setTeam((prev) => {
      const have = new Set([requester.id, ...prev.map((p) => p.id)]);
      return [...prev, ...d.dealTeam.filter((m) => !have.has(m.id))];
    });
    if (d.companyName) setTargetCompanies((prev) => (prev.length ? prev : [d.companyName]));
  };

  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErrors({});
    const payload: BriefInput = {
      dealId: deal?.id ?? "",
      title,
      objective,
      targetCompanies,
      competitors,
      targetLogos,
      expertTypes,
      decisionMakerRequired,
      geography,
      screener,
      callsTarget: Number(callsTarget),
      startDate,
      endDate,
      vendorIds,
      teamUserIds: team.map((p) => p.id),
      complianceNotes,
      additionalNotes,
    };
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (res.ok) {
        router.push(`/projects/${data.id}`);
        router.refresh();
        return;
      }
      setErrors(data.errors ?? { form: "The request could not be submitted." });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setErrors({ form: "Network error. Your entries are still here; try again." });
    }
    setBusy(false);
  }

  const errorList = ERROR_ORDER.map((k) => errors[k]).filter(Boolean);

  return (
    <form onSubmit={submit} noValidate>
      {errorList.length > 0 && (
        <div className="alert" role="alert">
          <strong>The request was not submitted.</strong>
          <ul>
            {errorList.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <section className="card accent">
        <h2>Requester and deal</h2>
        <p className="hint">Every expert network project is tied to one DealCloud deal.</p>
        <div className="row">
          <Field label="Associate" htmlFor="requester">
            <input id="requester" type="text" readOnly value={requester.name} />
          </Field>
          <Field label="Title and team" htmlFor="requester-role">
            <input
              id="requester-role"
              type="text"
              readOnly
              value={[requester.title, requester.team].filter(Boolean).join(", ")}
            />
          </Field>
        </div>
        <Field
          label="DealCloud deal"
          required
          htmlFor="deal"
          error={errors.dealId}
          hint={`Only deals with status Active or Lead can be linked. Your own deals are listed first. DealCloud data as of ${dealsSyncedAt}.`}
        >
          <DealPicker deal={deal} onChange={selectDeal} />
        </Field>
      </section>

      <section className="card">
        <h2>Team</h2>
        <p className="hint">
          Tag colleagues by name. Each person is notified and gets access to the project.
        </p>
        <Field
          label="Tagged team members"
          htmlFor="team"
          error={errors.teamUserIds}
          hint="The deal team is added automatically when you link a deal. Remove anyone who should not be included."
        >
          <PeoplePicker people={team} excludeId={requester.id} onChange={setTeam} />
        </Field>
      </section>

      <section className="card">
        <h2>Project brief</h2>
        <p className="hint">What the expert network needs to source the right people.</p>
        <Field label="Project title" required htmlFor="title" error={errors.title}>
          <input
            id="title"
            type="text"
            maxLength={140}
            placeholder="Wholesale Distributor Software / Payments"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field
          label="Objective and background"
          required
          htmlFor="objective"
          error={errors.objective}
          hint="Sent to the network as written. Do not include deal terms or the fact of a transaction."
        >
          <textarea
            id="objective"
            rows={5}
            placeholder="What the team is studying, who you want to speak with, and what you hope to learn."
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
          />
        </Field>
        <div className="row">
          <Field
            label="Target company"
            required
            htmlFor="targets"
            error={errors.targetCompanies}
            hint="Press Enter or comma to add."
          >
            <ChipInput
              id="targets"
              values={targetCompanies}
              onChange={setTargetCompanies}
              placeholder="Company the calls are about"
            />
          </Field>
          <Field label="Known competitors" htmlFor="competitors" hint="Optional.">
            <ChipInput
              id="competitors"
              values={competitors}
              onChange={setCompetitors}
              placeholder="Competitors to ask about"
            />
          </Field>
        </div>
        <Field label="Expert profiles wanted" required error={errors.expertTypes}>
          <div className="checks">
            {EXPERT_TYPES.map((t) => (
              <label key={t} className="check">
                <input
                  type="checkbox"
                  checked={expertTypes.includes(t)}
                  onChange={() => setExpertTypes(toggle(expertTypes, t))}
                />
                {t}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Seniority">
          <div className="checks">
            <label className="check">
              <input
                type="checkbox"
                checked={decisionMakerRequired}
                onChange={(e) => setDecisionMakerRequired(e.target.checked)}
              />
              Key decision makers only
            </label>
          </div>
        </Field>
        <Field
          label="Organisations to source experts from"
          htmlFor="logos"
          hint="Optional. Paste a comma separated list of customer logos or employers."
        >
          <ChipInput
            id="logos"
            values={targetLogos}
            onChange={setTargetLogos}
            placeholder="Erie Materials, Parksite, First Supply"
          />
        </Field>
        <Field label="Geography" htmlFor="geography" hint="Optional.">
          <input
            id="geography"
            type="text"
            placeholder="North America"
            value={geography}
            onChange={(e) => setGeography(e.target.value)}
          />
        </Field>
      </section>

      <section className="card">
        <h2>Screener questions</h2>
        <p className="hint">
          Every network is asked to answer exactly these, so candidates can be compared.
        </p>
        <div className="screener">
          {screener.map((q, i) => (
            <div key={i} className="q">
              <span className="n">{i + 1}.</span>
              <input
                type="text"
                aria-label={`Screener question ${i + 1}`}
                placeholder="Were you the primary decision maker for adopting this solution?"
                value={q}
                onChange={(e) => setScreener(screener.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => setScreener(screener.filter((_, j) => j !== i))}
                disabled={screener.length === 1}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="btn secondary sm"
          style={{ marginTop: 12 }}
          onClick={() => setScreener([...screener, ""])}
          disabled={screener.length >= 12}
        >
          Add question
        </button>
      </section>

      <section className="card">
        <h2>Logistics</h2>
        <p className="hint">Volume, timing and which network receives the request.</p>
        <div className="row">
          <Field label="Number of calls" required htmlFor="calls" error={errors.callsTarget}>
            <input
              id="calls"
              type="number"
              min={1}
              max={50}
              value={callsTarget}
              onChange={(e) => setCallsTarget(e.target.value)}
            />
          </Field>
          <Field label="Start" htmlFor="start">
            <input
              id="start"
              type="date"
              min={today}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="Calls needed by" required htmlFor="end" error={errors.endDate}>
            <input
              id="end"
              type="date"
              min={startDate || today}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Expert network" required error={errors.vendorIds}>
          <div className="checks">
            {vendors.map((v) => (
              <label key={v.id} className="check">
                <input
                  type="checkbox"
                  checked={vendorIds.includes(v.id)}
                  onChange={() => setVendorIds(toggle(vendorIds, v.id))}
                />
                {v.name}
              </label>
            ))}
          </div>
        </Field>
        <Field
          label="Compliance notes and exclusions"
          htmlFor="compliance"
          hint="Optional. Companies or people the network must not approach, such as current employees of the target."
        >
          <textarea
            id="compliance"
            rows={3}
            value={complianceNotes}
            onChange={(e) => setComplianceNotes(e.target.value)}
          />
        </Field>
        <Field label="Anything else for the network" htmlFor="notes" hint="Optional.">
          <textarea
            id="notes"
            rows={3}
            value={additionalNotes}
            onChange={(e) => setAdditionalNotes(e.target.value)}
          />
        </Field>
      </section>

      <div className="actions">
        <span className="hint">
          Submitting notifies {team.length} tagged {team.length === 1 ? "person" : "people"} and
          queues the request for the selected network.
        </span>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Submitting" : "Submit request"}
        </button>
      </div>
    </form>
  );
}
