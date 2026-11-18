import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { listCostCenters } from "@/modules/masterdata/service";
import { createExpenseReport, decideExpenseReport, getMileageRate, listExpenseReports, listPendingExpenseApprovals, setMileageRate, type ExpenseScope } from "@/modules/expenses/service";
import { STATUS_LABEL, type ExpenseStatus } from "@/modules/expenses/rules";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/expenses";

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const r = await runAction(BACK, () => createExpenseReport(ctx, { title: fd.get("title"), tripFrom: fd.get("tripFrom"), tripTo: fd.get("tripTo"), costCenterId: fd.get("costCenterId"), note: fd.get("note") }));
  redirect(`/expenses/${r.id}`);
}
async function decide(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => decideExpenseReport(ctx, { reportId: fd.get("reportId"), decision: fd.get("decision"), comment: fd.get("comment") }));
  revalidatePath(BACK);
}
async function rate(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setMileageRate(ctx, String(fd.get("rate") ?? "").replace(",", "."))); revalidatePath(BACK); }

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ error?: string; scope?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "expense.submit")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const scopes: [ExpenseScope, string][] = [["mine", "Meine"], ...(can(ctx, "expense.approve") ? [["team", "Mein Team"] as [ExpenseScope, string]] : []), ...(can(ctx, "expense.read_all") ? [["all", "Alle"] as [ExpenseScope, string]] : [])];
  const scope: ExpenseScope = scopes.some(([k]) => k === sp.scope) ? (sp.scope as ExpenseScope) : "mine";
  let reports, pending;
  try { [reports, pending] = await Promise.all([listExpenseReports(ctx, scope), listPendingExpenseApprovals(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const costCenters = can(ctx, "master.costcenter.read") ? await listCostCenters(ctx) : [];
  const mileage = await getMileageRate(ctx);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reisekosten und Spesen</h1>
        <p className="text-sm text-muted">Ausgaben erfassen, Belege anhängen, einreichen. Die Freigabe folgt der Regel der Organisation (Führungskraft, ab einem Betrag zusätzlich Finanzen). Beträge sind brutto wie ausgelegt; ein Vorsteuerabzug wird hier nicht berechnet.</p>
      </div>
      <ErrorBanner message={sp.error} />

      {pending.length > 0 && (
        <section className="space-y-2" aria-label="Zur Freigabe">
          <h2 className="font-medium">Zur Freigabe</h2>
          <ul className="space-y-2">
            {pending.map((a) => (
              <li key={a.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
                <Link className="font-medium text-accent underline" href={`/expenses/${a.expenseReport.id}`}>{a.expenseReport.number} · {a.expenseReport.title}</Link> · {a.employeeName} · {formatMoney(a.expenseReport.totalAmount.toString(), a.expenseReport.currency)} · Schritt: {a.label}
                <form action={decide} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="reportId" value={a.expenseReport.id} />
                  <label>Kommentar<input name="comment" maxLength={300} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
                  <button name="decision" value="APPROVE" className={primary}>Freigeben</button>
                  <button name="decision" value="REJECT" className="rounded-md border border-line px-3 py-1.5">Ablehnen (Begründung nötig)</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
        <h2 className="font-medium sm:col-span-6">Neue Abrechnung</h2>
        <label className="sm:col-span-2">Titel<input name="title" required maxLength={120} className={input} /></label>
        <label>Reise von<input type="date" name="tripFrom" className={input} /></label>
        <label>Reise bis<input type="date" name="tripTo" className={input} /></label>
        <label>Kostenstelle<select name="costCenterId" className={input}><option value="">–</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></label>
        <div className="flex items-end"><button className={primary}>Anlegen</button></div>
      </form>

      {can(ctx, "finance.master.write") && (
        <form action={rate} className="flex flex-wrap items-end gap-3 text-sm">
          <label>Kilometergeld je km (€)<input name="rate" inputMode="decimal" defaultValue={mileage.toString()} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
          <button className="rounded-md border border-line px-3 py-1.5">Satz speichern</button>
          <span className="text-muted">gilt für neu erfasste Positionen</span>
        </form>
      )}

      <nav aria-label="Ansicht" className="flex gap-4 text-sm">
        {scopes.map(([k, label]) => <Link key={k} href={`${BACK}?scope=${k}`} aria-current={scope === k ? "page" : undefined} className={scope === k ? "font-semibold underline" : "text-accent underline"}>{label}</Link>)}
      </nav>
      {reports.length === 0 ? <p className="text-sm text-muted">Keine Abrechnungen.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Nummer</th><th>Titel</th>{scope !== "mine" && <th>Person</th>}<th className="text-right">Summe</th><th>Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {reports.map((r) => (
              <tr key={r.id}>
                <td className="py-2"><Link className="text-accent underline" href={`/expenses/${r.id}`}>{r.number ?? "Entwurf"}</Link></td><td>{r.title}</td>
                {scope !== "mine" && <td>{r.employeeName}</td>}
                <td className="text-right">{formatMoney(r.totalAmount.toString(), r.currency)}</td><td>{STATUS_LABEL[r.status as ExpenseStatus]}{r.paidOn ? ` am ${r.paidOn.toISOString().slice(0, 10)}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
