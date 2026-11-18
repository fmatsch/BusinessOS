import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { decideInspection, getInspection, recordInspectionResult } from "@/modules/quality/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const here = (id: string) => `/quality/${id}`;
const STATUS: Record<string, string> = { OPEN: "offen", ACCEPTED: "angenommen", REJECTED: "abgelehnt" };

async function record(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  await runAction(here(id), () => recordInspectionResult(ctx, id, { characteristicId: fd.get("characteristicId"), value: String(fd.get("value") ?? "").replace(",", "."), passed: fd.get("passed"), note: fd.get("note") }));
  revalidatePath(here(id));
}
async function decide(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  await runAction(here(id), () => decideInspection(ctx, id, { decision: fd.get("decision"), note: fd.get("note"), deviation: fd.get("deviation") === "on" }));
  revalidatePath(here(id));
}

export default async function InspectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let insp;
  try { insp = await getInspection(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const inspector = can(ctx, "qm.inspect") && insp.status === "OPEN", decider = can(ctx, "qm.decide") && insp.status === "OPEN";
  const input = "rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/quality">← Qualität</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Prüflos {insp.number} · {STATUS[insp.status]}{insp.deviation ? " (Sonderfreigabe)" : ""}</h1>
        <p className="text-sm text-muted">{insp.item.number} {insp.item.name} · Menge {insp.quantity.toString()}{insp.batchNumber ? ` · Charge ${insp.batchNumber}` : ""}{insp.reference ? ` · ${insp.reference}` : ""} · Prüfplan Version {insp.planVersion}</p>
        {insp.decisionNote && <p className="text-sm">Begründung: {insp.decisionNote}</p>}
        {insp.nonConformances.length > 0 && <p className="text-sm">Abweichung: <Link className="text-accent underline" href="/quality/nc">{insp.nonConformances.map((n) => n.number).join(", ")}</Link></p>}
      </div>
      <ErrorBanner message={error} />
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Prüfmerkmale und Ergebnisse</caption>
        <thead className="text-muted"><tr><th scope="col" className="py-2">Merkmal</th><th scope="col">Vorgabe</th><th scope="col">Ergebnis</th><th scope="col">Bewertung</th>{inspector && <th scope="col">Erfassen</th>}</tr></thead>
        <tbody className="divide-y divide-line">
          {insp.characteristics.map((c) => (
            <tr key={c.id}>
              <td className="py-1.5">{c.position}. {c.name}</td>
              <td>{c.kind === "QUALITATIVE" ? "in Ordnung" : `${c.minValue?.toString() ?? "–"} bis ${c.maxValue?.toString() ?? "–"} ${c.unit ?? ""}`}</td>
              <td>{c.result ? (c.result.value !== null ? `${c.result.value.toString()} ${c.unit ?? ""}` : c.result.passed ? "in Ordnung" : "nicht in Ordnung") : "–"}{c.result?.note ? ` (${c.result.note})` : ""}</td>
              <td>{c.result ? (c.result.passed ? "bestanden" : "nicht bestanden") : "offen"}</td>
              {inspector && (
                <td>
                  <form action={record} className="flex flex-wrap items-center gap-2" aria-label={`Ergebnis ${c.name}`}>
                    <input type="hidden" name="id" value={insp.id} /><input type="hidden" name="characteristicId" value={c.id} />
                    {c.kind === "QUANTITATIVE"
                      ? <input name="value" inputMode="decimal" required aria-label={`Messwert ${c.name}`} className={input + " w-24"} />
                      : <select name="passed" required aria-label={`Ergebnis ${c.name}`} className={input}><option value="">–</option><option value="true">in Ordnung</option><option value="false">nicht in Ordnung</option></select>}
                    <input name="note" placeholder="Notiz" maxLength={300} aria-label={`Notiz ${c.name}`} className={input + " w-28"} />
                    <button className="rounded-md border border-line px-2 py-1">Speichern</button>
                  </form>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {decider && (
        <form action={decide} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Entscheid">
          <input type="hidden" name="id" value={insp.id} />
          <h2 className="font-medium">Verwendungsentscheid</h2>
          <label className="block">Begründung / Notiz<input name="note" maxLength={500} className={input + " mt-1 block w-full"} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" name="deviation" /> Sonderfreigabe (Annahme trotz nicht bestandener Merkmale, Begründung Pflicht)</label>
          <div className="flex gap-3">
            <button name="decision" value="ACCEPT" className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Annehmen</button>
            <button name="decision" value="REJECT" className="rounded-md border border-line px-3 py-1.5">Ablehnen</button>
          </div>
        </form>
      )}
    </div>
  );
}
