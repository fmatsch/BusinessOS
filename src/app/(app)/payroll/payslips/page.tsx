import Link from "next/link";
import { Fragment } from "react";
import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { myPayslip, myPayslips } from "@/modules/payroll/run";
import { formatMoney } from "@/lib/money";

export const dynamic = "force-dynamic";

type Detail = { regularGross: string; specialGross: string; svEmployeeBreakdown: Record<string, string>; taxRegular: string; taxSpecial: string };

export default async function PayslipsPage({ searchParams }: { searchParams: Promise<{ line?: string }> }) {
  const { line } = await searchParams;
  const ctx = await requireContext();
  let list, one = null;
  try {
    list = await myPayslips(ctx);
    if (line) one = await myPayslip(ctx, line).catch(() => null);
  } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const d = one?.detail as Detail | undefined;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Meine Lohnabrechnungen</h1>
        <p className="text-sm text-muted">Hier sehen Sie nur Ihre eigenen, freigegebenen Abrechnungen.</p>
      </div>
      {list.length === 0 ? <p className="text-sm text-muted">Noch keine freigegebene Abrechnung.</p> : (
        <ul className="divide-y divide-line text-sm">
          {list.map((l) => (
            <li key={l.id} className="flex items-center justify-between py-2"><span>{l.run.year}-{String(l.run.month).padStart(2, "0")}</span><span>Netto {formatMoney(l.net.toString())}</span><Link className="text-accent underline" href={`/payroll/payslips?line=${l.id}`}>Anzeigen</Link></li>
          ))}
        </ul>
      )}
      {one && d && (
        <section className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Abrechnung">
          <h2 className="font-medium">Abrechnung {one.run.year}-{String(one.run.month).padStart(2, "0")}</h2>
          <dl className="grid grid-cols-2 gap-1">
            <dt>Laufender Bezug</dt><dd className="text-right">{formatMoney(d.regularGross)}</dd>
            <dt>Sonstiger Bezug</dt><dd className="text-right">{formatMoney(d.specialGross)}</dd>
            <dt className="font-medium">Brutto</dt><dd className="text-right font-medium">{formatMoney(one.gross.toString())}</dd>
            {Object.entries(d.svEmployeeBreakdown).map(([k, v]) => <Fragment key={k}><dt>SV {k}</dt><dd className="text-right">− {formatMoney(v)}</dd></Fragment>)}
            <dt>Lohnsteuer laufend</dt><dd className="text-right">− {formatMoney(d.taxRegular)}</dd>
            <dt>Lohnsteuer sonstiger Bezug</dt><dd className="text-right">− {formatMoney(d.taxSpecial)}</dd>
            <dt className="font-medium">Auszahlung (Netto)</dt><dd className="text-right font-medium">{formatMoney(one.net.toString())}</dd>
          </dl>
        </section>
      )}
    </div>
  );
}
