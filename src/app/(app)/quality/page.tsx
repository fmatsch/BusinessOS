import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createInspection, listInspections, listInspectionPlans } from "@/modules/quality/service";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/quality";
const STATUS: Record<string, string> = { OPEN: "offen", ACCEPTED: "angenommen", REJECTED: "abgelehnt" };
const SOURCE: Record<string, string> = { MANUAL: "manuell", GOODS_RECEIPT: "Wareneingang", PRODUCTION: "Fertigung" };

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const i = await runAction(BACK, () => createInspection(ctx, { itemId: fd.get("itemId"), quantity: String(fd.get("quantity") ?? "").replace(",", "."), batchNumber: fd.get("batchNumber"), source: fd.get("source"), reference: fd.get("reference") }));
  redirect(`/quality/${i.id}`);
}

export default async function QualityPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let inspections, plans;
  try { [inspections, plans] = await Promise.all([listInspections(ctx), listInspectionPlans(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const inspector = can(ctx, "qm.inspect");
  const active = plans.filter((p) => p.status === "ACTIVE");
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Qualität</h1>
        <p className="text-sm text-muted">Prüfpläne je Artikel, Prüflose mit bewerteten Messwerten, Verwendungsentscheid (Annahme, Ablehnung, Sonderfreigabe) und Abweichungen mit Ursache und Maßnahme. Nicht enthalten: Stichprobenpläne (AQL), Statistik (SPC), Sperrbestand im Lager, Lieferantenbewertung, Audits.</p>
      </div>
      <ErrorBanner message={error} />
      <p className="flex flex-wrap gap-4 text-sm">
        <Link className="text-accent underline" href="/quality/plans">Prüfpläne</Link>
        <Link className="text-accent underline" href="/quality/nc">Abweichungen</Link>
      </p>
      {inspector && (
        <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-5" aria-label="Prüflos anlegen">
          <h2 className="font-medium sm:col-span-5">Prüflos anlegen</h2>
          <label className="sm:col-span-2">Artikel (mit aktivem Prüfplan)<select name="itemId" required className={input}><option value="">–</option>{active.map((p) => <option key={p.id} value={p.itemId}>{p.item.number} {p.item.name}</option>)}</select></label>
          <label>Menge<input name="quantity" required inputMode="decimal" className={input} /></label>
          <label>Charge<input name="batchNumber" maxLength={40} className={input} /></label>
          <label>Anlass<select name="source" className={input}>{Object.entries(SOURCE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="sm:col-span-3">Bezug (z. B. Lieferschein, Fertigungsauftrag)<input name="reference" maxLength={120} className={input} /></label>
          <div className="sm:col-span-5"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button></div>
        </form>
      )}
      {inspections.length === 0 ? <p className="text-sm text-muted">Noch keine Prüflose.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Prüflose</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Nummer</th><th scope="col">Artikel</th><th scope="col" className="text-right">Menge</th><th scope="col">Charge</th><th scope="col">Anlass</th><th scope="col">Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {inspections.map((i) => (
              <tr key={i.id}><td className="py-1.5"><Link className="text-accent underline" href={`/quality/${i.id}`}>{i.number}</Link></td><td>{i.item.number} {i.item.name}</td><td className="text-right">{i.quantity.toString()}</td><td>{i.batchNumber ?? ""}</td><td>{SOURCE[i.source]}</td><td>{STATUS[i.status]}{i.deviation ? " (Sonderfreigabe)" : ""}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
