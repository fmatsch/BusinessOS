"use client";

import Link from "next/link";
import { useActionState } from "react";
import { ask, decideProposal, type CopilotState, type ProposalState } from "./actions";

const EXAMPLES = [
  "Welche Anforderungen warten auf Freigabe?",
  "Welche Kostenstellen überschreiten ihr Budget?",
  "Welche Abteilungen haben die höchsten Bestellvolumina?",
];

function ProposalCard({ id, summary }: { id: string; summary: string }) {
  const [state, action, pending] = useActionState<ProposalState, FormData>(decideProposal, {});
  return (
    <li className="space-y-2 rounded-lg border border-line bg-bg p-3">
      <p><strong>Vorschlag:</strong> {summary}</p>
      {state.done ? (
        <p role="status">{state.message}{state.href && <> · <Link className="text-accent underline" href={state.href}>ansehen</Link></>}</p>
      ) : (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="id" value={id} />
          <button name="decision" value="confirm" disabled={pending} className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg disabled:opacity-60">Ausführen</button>
          <button name="decision" value="reject" disabled={pending} className="rounded-md border border-line px-3 py-1.5 disabled:opacity-60">Verwerfen</button>
          <span className="text-xs text-muted">Es ist noch nichts geändert. Ausgeführt wird mit Ihren Berechtigungen.</span>
        </form>
      )}
      {state.error && <p role="alert" className="text-red-700 dark:text-red-300">{state.error}</p>}
    </li>
  );
}

export function CopilotChat() {
  const [state, action, pending] = useActionState<CopilotState, FormData>(ask, {});
  return (
    <div className="space-y-6">
      <form action={action} className="space-y-3">
        <label htmlFor="question" className="text-sm text-muted">Ihre Frage</label>
        <textarea id="question" name="question" required maxLength={1000} rows={3}
          defaultValue={state.question} placeholder="z. B. Wie viel Budget ist in der Kostenstelle IT noch verfügbar?"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm" />
        <div className="flex items-center gap-3">
          <button disabled={pending} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-60">
            {pending ? "Wird beantwortet …" : "Fragen"}
          </button>
          <span className="text-xs text-muted">Beispiele: {EXAMPLES.join(" · ")}</span>
        </div>
      </form>

      {state.error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{state.error}</p>}

      {state.answer !== undefined && (
        <section aria-live="polite" className="space-y-3 rounded-xl border border-line bg-surface p-5 text-sm">
          {state.status === "refused" && <p className="font-medium">Die KI hat diese Anfrage aus Sicherheitsgründen abgelehnt.</p>}
          {state.status === "truncated" && <p className="text-muted">Die Antwort wurde gekürzt.</p>}
          {state.status === "limit" && <p className="text-muted">Die Abfrage wurde nach zu vielen Schritten abgebrochen.</p>}
          <p className="whitespace-pre-wrap">{state.answer || "Keine Antwort."}</p>
          {state.proposals && state.proposals.length > 0 && (
            <div className="space-y-2" aria-label="Vorschläge">
              <h2 className="font-medium">Vorgeschlagene Änderungen – bitte prüfen</h2>
              <ul className="space-y-2">{state.proposals.map((p) => <ProposalCard key={p.id} id={p.id} summary={p.summary} />)}</ul>
            </div>
          )}
          <div className="border-t border-line pt-3">
            <h2 className="mb-1 font-medium">Quellen (vom System ermittelt)</h2>
            {state.sources && state.sources.length > 0 ? (
              <ul className="list-disc pl-5">
                {state.sources.map((s) => (
                  <li key={`${s.type}:${s.id}`}>{s.href ? <Link className="text-accent underline" href={s.href}>{s.label}</Link> : s.label}</li>
                ))}
              </ul>
            ) : <p className="text-muted">Keine Datensätze abgefragt – die Antwort stützt sich auf keine Geschäftsdaten.</p>}
          </div>
        </section>
      )}
    </div>
  );
}
