import Link from "next/link";
import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError } from "@/platform/errors";
import { valuationReport } from "@/modules/inventory/service";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

export default async function ValuationPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { asOf } = await searchParams;
  const ctx = await requireContext();
  let rep, problem = "";
  try { rep = await valuationReport(ctx, asOf || undefined); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    if (!(e instanceof ConflictError)) throw e;
    problem = e.message;
    rep = await valuationReport(ctx);
  }
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/inventory">← Lager</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Lagerbewertung</h1>
        <p className="text-sm text-muted">Wert aus dem Bewegungsjournal (gleitender Durchschnitt oder FIFO je Artikel), Einstandspreis = Preis der Bestellposition. Es wird nichts ins Hauptbuch gebucht.</p>
      </div>
      {problem && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{problem}</p>}
      <form method="get" className="flex items-end gap-3 text-sm" aria-label="Stichtag">
        <label>Stichtag<input type="date" name="asOf" defaultValue={rep.asOf} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
        <button className="rounded-md border border-line px-3 py-1.5">Anzeigen</button>
      </form>
      {rep.rows.length === 0 ? <p className="text-sm text-muted">Kein bewerteter Bestand.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Lagerbewertung zum {rep.asOf}</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Artikel</th><th scope="col">Verfahren</th><th scope="col" className="text-right">Bestand</th><th scope="col" className="text-right">Ø Einstand</th><th scope="col" className="text-right">Wert</th></tr></thead>
          <tbody className="divide-y divide-line">
            {rep.rows.map((r) => (
              <tr key={r.id}><td className="py-1.5"><Link className="text-accent underline" href={`/inventory/${r.id}`}>{r.number}</Link> {r.name}</td><td>{r.method === "FIFO" ? "FIFO" : "Ø"}</td><td className="text-right">{r.quantity.toString()} {r.unit}</td><td className="text-right">{r.averageCost.toFixed(2)}</td><td className="text-right">{formatMoney(r.value.toString())}</td></tr>
            ))}
          </tbody>
          <tfoot><tr className="font-medium"><td className="py-2" colSpan={4}>Summe</td><td className="text-right">{formatMoney(rep.total.toString())}</td></tr></tfoot>
        </table>
      )}
    </div>
  );
}
