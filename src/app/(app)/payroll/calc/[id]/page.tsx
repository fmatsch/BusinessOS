import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { approveRun, cancelRun, discardRun, getRun, recalcRun } from "@/modules/payroll/run";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";
const STATUS: Record<string, string> = { DRAFT: "Entwurf", APPROVED: "freigegeben", CANCELLED: "storniert" };

async function approve(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/payroll/calc/${id}`, () => approveRun(ctx, id)); revalidatePath(`/payroll/calc/${id}`); }
async function cancel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/payroll/calc/${id}`, () => cancelRun(ctx, id, String(fd.get("reason") ?? ""))); revalidatePath(`/payroll/calc/${id}`); }
async function discard(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/payroll/calc/${id}`, () => discardRun(ctx, id)); revalidatePath("/payroll/calc"); }
async function recalc(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  const inputs = [...fd.keys()].filter((k) => k.startsWith("extra_")).map((k) => k.slice(6)).map((emp) => ({
    employeeId: emp, regularExtra: String(fd.get(`extra_${emp}`) || "0").replace(",", "."), special: String(fd.get(`special_${emp}`) || "0").replace(",", "."),
  }));
  await runAction(`/payroll/calc/${id}`, () => recalcRun(ctx, id, { inputs }));
  revalidatePath(`/payroll/calc/${id}`);
}

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const ctx = await requireContext();
  let run;
  try { run = await getRun(ctx, id); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manager = can(ctx, "payroll.calc.manage"), approver = can(ctx, "payroll.calc.approve");
  const draft = run.status === "DRAFT";
  const warnings = run.lines.flatMap((l) => ((l.detail as { warnings?: string[] }).warnings ?? []).map((w) => `${l.employeeNumber} ${l.employeeName}: ${w}`));
  const input = "rounded-md border border-line bg-bg px-2 py-1 w-28 text-right";

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/payroll/calc">← Lohnabrechnung</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Lauf {run.year}-{String(run.month).padStart(2, "0")} (Version {run.version}) – {STATUS[run.status]}</h1>
        <p className="text-sm text-muted">Parametersatz: {run.paramsValidated ? "geprüft" : "noch nicht geprüft – Freigabe erst nach Prüfung möglich"}. Entwurfswerte sind keine Rechtsauskunft.</p>
      </div>
      <ErrorBanner message={error} />
      {warnings.length > 0 && <ul className="list-disc pl-5 text-sm">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}

      <form action={recalc} aria-label="Eingaben des Monats">
        <input type="hidden" name="id" value={run.id} />
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Abrechnung je Mitarbeiter</caption>
          <thead className="text-muted"><tr>
            <th scope="col" className="py-2">Mitarbeiter</th>{draft && manager && <><th scope="col" className="text-right">Zulagen</th><th scope="col" className="text-right">Sonst. Bezug</th></>}
            <th scope="col" className="text-right">Brutto</th><th scope="col" className="text-right">SV</th><th scope="col" className="text-right">Lohnsteuer</th><th scope="col" className="text-right">Netto</th><th scope="col" className="text-right">AG-Kosten</th>
          </tr></thead>
          <tbody className="divide-y divide-line">
            {run.lines.map((l) => (
              <tr key={l.id}>
                <td className="py-1.5">{l.employeeNumber} {l.employeeName}</td>
                {draft && manager && <><td className="text-right"><input name={`extra_${l.employeeId}`} defaultValue={l.regularExtra.toString()} inputMode="decimal" aria-label={`Zulagen ${l.employeeName}`} className={input} /></td><td className="text-right"><input name={`special_${l.employeeId}`} defaultValue={l.special.toString()} inputMode="decimal" aria-label={`Sonstiger Bezug ${l.employeeName}`} className={input} /></td></>}
                <td className="text-right">{formatMoney(l.gross.toString())}</td><td className="text-right">{formatMoney(l.svEmployee.toString())}</td><td className="text-right">{formatMoney(l.tax.toString())}</td><td className="text-right">{formatMoney(l.net.toString())}</td><td className="text-right">{formatMoney(l.employerCost.toString())}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="font-medium"><td className="py-2">Summe</td>{draft && manager && <td colSpan={2} />}<td className="text-right">{formatMoney(run.totals.gross.toString())}</td><td className="text-right">{formatMoney(run.totals.svEmployee.toString())}</td><td className="text-right">{formatMoney(run.totals.tax.toString())}</td><td className="text-right">{formatMoney(run.totals.net.toString())}</td><td className="text-right">{formatMoney(run.totals.employerCost.toString())}</td></tr></tfoot>
        </table>
        {draft && manager && <button className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm">Neu berechnen</button>}
      </form>

      <div className="flex flex-wrap items-start gap-4 text-sm">
        {draft && approver && <form action={approve}><input type="hidden" name="id" value={run.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Freigeben</button></form>}
        {draft && manager && <form action={discard}><input type="hidden" name="id" value={run.id} /><button className="rounded-md border border-line px-3 py-1.5">Entwurf verwerfen</button></form>}
        {run.status === "APPROVED" && <a className="rounded-md border border-line px-3 py-1.5" href={`/payroll/calc/${run.id}/csv`}>CSV herunterladen</a>}
        {run.status === "APPROVED" && approver && (
          <form action={cancel} className="flex items-end gap-2"><input type="hidden" name="id" value={run.id} />
            <label>Storno-Begründung<input name="reason" required minLength={3} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
            <button className="rounded-md border border-line px-3 py-1.5">Lauf stornieren</button></form>
        )}
      </div>
    </div>
  );
}
