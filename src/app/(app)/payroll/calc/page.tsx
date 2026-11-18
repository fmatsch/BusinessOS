import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createParamSet, createRun, listParamSets, listPayrollTerms, listRuns, setPayrollTerms, validateParamSet } from "@/modules/payroll/run";
import { listEmployees } from "@/modules/hr/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/payroll/calc";

async function addParams(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createParamSet(ctx, { label: fd.get("label"), validFrom: fd.get("validFrom"), source: fd.get("source") })); revalidatePath(BACK); }
async function validateParams(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => validateParamSet(ctx, String(fd.get("id")))); revalidatePath(BACK); }
async function addTerms(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const n = (k: string) => String(fd.get(k) || "0").replace(",", ".");
  await runAction(BACK, () => setPayrollTerms(ctx, { employeeId: fd.get("employeeId"), validFrom: fd.get("validFrom"), monthlyGross: n("monthlyGross"), marginal: fd.get("marginal") === "on", allowanceMonthly: n("allowanceMonthly"), commuterMonthly: n("commuterMonthly"), familyBonusChildren: fd.get("familyBonusChildren") || 0 }));
  revalidatePath(BACK);
}
async function newRun(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createRun(ctx, { year: fd.get("year"), month: fd.get("month"), inputs: [] }));
  revalidatePath(BACK);
}

const STATUS: Record<string, string> = { DRAFT: "Entwurf", APPROVED: "freigegeben", CANCELLED: "storniert" };

export default async function PayrollCalcPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let sets, terms, runs, employees;
  try { [sets, terms, runs, employees] = await Promise.all([listParamSets(ctx), listPayrollTerms(ctx), listRuns(ctx), listEmployees(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manager = can(ctx, "payroll.calc.manage"), paramMgr = can(ctx, "payroll.params.manage");
  const now = new Date(); const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const current = new Map<string, (typeof terms)[number]>();
  for (const t of terms) if (!current.has(t.employeeId)) current.set(t.employeeId, t); // je Mitarbeiter die jüngste Zeile

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/payroll">← Lohn-Export</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Lohnabrechnung (Österreich)</h1>
        <p className="text-sm text-muted">Berechnet laufende Bezüge und sonstige Bezüge mit Sozialversicherung, Lohnsteuer und Arbeitgeberkosten aus einer versionierten Parametertabelle. <strong>Die mitgelieferten Werte sind ein Entwurf</strong> – eine Freigabe ist erst möglich, wenn eine zweite Person den Parametersatz geprüft hat. Nicht abgedeckt: u. a. Jahreskumulierung sonstiger Bezüge, Sachbezüge, Pendlerrechner, Abfertigung, Meldungen (ELDA, Lohnzettel).</p>
      </div>
      <ErrorBanner message={error} />

      <section className="space-y-3">
        <h2 className="font-medium">Abrechnungsläufe</h2>
        {manager && (
          <form action={newRun} className="flex flex-wrap items-end gap-3 text-sm" aria-label="Lauf berechnen">
            <label>Jahr<input name="year" type="number" defaultValue={prev.getUTCFullYear()} className={input + " w-24"} /></label>
            <label>Monat<input name="month" type="number" min={1} max={12} defaultValue={prev.getUTCMonth() + 1} className={input + " w-20"} /></label>
            <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Lauf berechnen</button>
          </form>
        )}
        {runs.length === 0 ? <p className="text-sm text-muted">Noch keine Läufe.</p> : (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Abrechnungsläufe</caption>
            <thead className="text-muted"><tr><th scope="col" className="py-2">Monat</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col" className="text-right">Beschäftigte</th><th scope="col">Parametersatz</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {runs.map((r) => (
                <tr key={r.id}><td className="py-1.5">{r.year}-{String(r.month).padStart(2, "0")}</td><td>{r.version}</td><td>{STATUS[r.status]}</td><td className="text-right">{r._count.lines}</td><td>{r.paramsValidated ? "geprüft" : "ungeprüft"}</td><td><Link className="text-accent underline" href={`/payroll/calc/${r.id}`}>Öffnen</Link></td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Parametersätze</h2>
        <p className="text-sm text-muted">Sätze, Grenzen und Tarif gelten ab einem Datum und sind nach dem Anlegen unveränderlich. Beim Anlegen werden die Entwurfswerte (Österreich) übernommen; die Prüfung gegen die amtlichen Werte bestätigt eine zweite Person.</p>
        {paramMgr && (
          <form action={addParams} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3" aria-label="Parametersatz anlegen">
            <label>Bezeichnung<input name="label" required maxLength={120} className={input} /></label>
            <label>Gültig ab<input name="validFrom" type="date" required className={input} /></label>
            <label>Quelle der Werte<input name="source" required maxLength={500} placeholder="z. B. Lohnverrechnung, Stand" className={input} /></label>
            <div className="sm:col-span-3"><button className="rounded-md border border-line px-3 py-1.5">Anlegen (Entwurfswerte)</button></div>
          </form>
        )}
        {sets.length > 0 && (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Parametersätze</caption>
            <thead className="text-muted"><tr><th scope="col" className="py-2">Bezeichnung</th><th scope="col">Gültig ab</th><th scope="col">Quelle</th><th scope="col">Prüfung</th></tr></thead>
            <tbody className="divide-y divide-line">
              {sets.map((s) => (
                <tr key={s.id}><td className="py-1.5">{s.label}</td><td>{s.validFrom.toISOString().slice(0, 10)}</td><td>{s.source}</td>
                  <td>{s.validatedAt ? `geprüft ${s.validatedAt.toISOString().slice(0, 10)}` : paramMgr && s.createdById !== ctx.userId ? <form action={validateParams}><input type="hidden" name="id" value={s.id} /><button className="rounded-md border border-line px-2 py-0.5">Als geprüft bestätigen</button></form> : "ungeprüft"}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Vertragsdaten</h2>
        <p className="text-sm text-muted">Gehälter sind vertraulich: Der Zugriff wird protokolliert. Änderungen gelten ab einem Datum (neue Zeile, die alte bleibt).</p>
        {manager && (
          <form action={addTerms} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3" aria-label="Vertragsdaten erfassen">
            <label>Mitarbeiter<select name="employeeId" required className={input}><option value="">–</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.number} {e.firstName} {e.lastName}</option>)}</select></label>
            <label>Gültig ab<input name="validFrom" type="date" required className={input} /></label>
            <label>Monatsgehalt brutto<input name="monthlyGross" required inputMode="decimal" className={input} /></label>
            <label>Freibetrag/Monat<input name="allowanceMonthly" inputMode="decimal" placeholder="0" className={input} /></label>
            <label>Pendlerpauschale/Monat<input name="commuterMonthly" inputMode="decimal" placeholder="0" className={input} /></label>
            <label>Kinder (Familienbonus)<input name="familyBonusChildren" type="number" min={0} defaultValue={0} className={input} /></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="marginal" /> geringfügig beschäftigt</label>
            <div className="sm:col-span-3"><button className="rounded-md border border-line px-3 py-1.5">Speichern</button></div>
          </form>
        )}
        {current.size === 0 ? <p className="text-sm text-muted">Noch keine Vertragsdaten.</p> : (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Aktuelle Vertragsdaten</caption>
            <thead className="text-muted"><tr><th scope="col" className="py-2">Mitarbeiter</th><th scope="col">Gültig ab</th><th scope="col" className="text-right">Brutto/Monat</th><th scope="col">Geringfügig</th><th scope="col" className="text-right">Kinder</th></tr></thead>
            <tbody className="divide-y divide-line">
              {[...current.values()].map((t) => (
                <tr key={t.id}><td className="py-1.5">{t.employee.number} {t.employee.firstName} {t.employee.lastName}</td><td>{t.validFrom.toISOString().slice(0, 10)}</td><td className="text-right">{formatMoney(t.monthlyGross.toString())}</td><td>{t.marginal ? "ja" : "nein"}</td><td className="text-right">{t.familyBonusChildren}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
