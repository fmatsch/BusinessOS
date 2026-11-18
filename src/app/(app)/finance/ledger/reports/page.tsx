import Link from "next/link";
import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { accountLedger, balanceSheetReport, incomeStatementReport, trialBalance } from "@/modules/gl/service";
import { listAccounts } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner } from "../../../action-helpers";

export const dynamic = "force-dynamic";
const TABS: [string, string][] = [["trial", "Saldenliste"], ["pl", "GuV"], ["bs", "Bilanz"], ["ledger", "Kontoblatt"]];

export default async function LedgerReports({ searchParams }: { searchParams: Promise<{ tab?: string; from?: string; to?: string; account?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireContext();
  const year = new Date().getUTCFullYear();
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : "trial";
  const from = sp.from ?? `${year}-01-01`, to = sp.to ?? new Date().toISOString().slice(0, 10);
  let accounts;
  try { accounts = await listAccounts(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const money = (v: { toString(): string }) => formatMoney(v.toString());
  let body: React.ReactNode = null, error: string | undefined;
  try {
    if (tab === "trial") {
      const t = await trialBalance(ctx, { from, to });
      body = (
        <table className="w-full text-left text-sm"><caption className="sr-only">Saldenliste</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Konto</th><th scope="col" className="text-right">Eröffnung</th><th scope="col" className="text-right">Soll</th><th scope="col" className="text-right">Haben</th><th scope="col" className="text-right">Saldo</th></tr></thead>
          <tbody className="divide-y divide-line">{t.rows.map((r) => <tr key={r.accountId}><td className="py-1.5"><Link className="text-accent underline" href={`/finance/ledger/reports?tab=ledger&account=${r.accountId}&from=${from}&to=${to}`}>{r.number} {r.name}</Link></td><td className="text-right">{money(r.open)}</td><td className="text-right">{money(r.debit)}</td><td className="text-right">{money(r.credit)}</td><td className="text-right">{money(r.closing)}</td></tr>)}</tbody>
          <tfoot><tr className="font-medium"><td className="py-2">Summe</td><td /><td className="text-right">{money(t.totals.debit)}</td><td className="text-right">{money(t.totals.credit)}</td><td className="text-right">{money(t.totals.closing)}</td></tr></tfoot>
        </table>
      );
    } else if (tab === "pl") {
      const g = await incomeStatementReport(ctx, { from, to });
      const part = (title: string, s: typeof g.income) => (<><tr><th colSpan={2} className="pt-4 text-left font-medium">{title}</th></tr>{s.rows.map((r) => <tr key={r.accountId}><td className="py-1">{r.number} {r.name}</td><td className="text-right">{money(r.amount)}</td></tr>)}<tr className="font-medium"><td className="py-1">Summe {title}</td><td className="text-right">{money(s.total)}</td></tr></>);
      body = <table className="w-full max-w-xl text-left text-sm"><caption className="sr-only">Gewinn- und Verlustrechnung</caption><tbody>{part("Erträge", g.income)}{part("Aufwände", g.expense)}<tr className="border-t border-line text-base font-semibold"><td className="pt-3">{g.result.gte(0) ? "Gewinn" : "Verlust"}</td><td className="pt-3 text-right">{money(g.result)}</td></tr></tbody></table>;
    } else if (tab === "bs") {
      const b = await balanceSheetReport(ctx, to);
      const part = (title: string, s: typeof b.assets) => (<><tr><th colSpan={2} className="pt-4 text-left font-medium">{title}</th></tr>{s.rows.map((r) => <tr key={r.accountId}><td className="py-1">{r.number} {r.name}</td><td className="text-right">{money(r.amount)}</td></tr>)}<tr className="font-medium"><td className="py-1">Summe {title}</td><td className="text-right">{money(s.total)}</td></tr></>);
      body = (
        <div className="space-y-3">
          {b.unclassified.length > 0 && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">Konten mit Buchungen ohne Einordnung (fehlen in Bilanz und GuV): {b.unclassified.map((u) => `${u.number} ${u.name}`).join(", ")}. Bitte unter Einrichtung einordnen.</p>}
          <table className="w-full max-w-xl text-left text-sm"><caption className="sr-only">Bilanz zum {b.asOf}</caption><tbody>
            {part("Aktiva", b.assets)}
            <tr className="font-semibold"><td className="pt-3">Summe Aktiva</td><td className="pt-3 text-right">{money(b.assets.total)}</td></tr>
            {part("Fremdkapital", b.liabilities)}
            {part("Eigenkapital", b.equity)}
            <tr><td className="py-1">Ergebnisvortrag (frühere Geschäftsjahre)</td><td className="text-right">{money(b.retained)}</td></tr>
            <tr><td className="py-1">Ergebnis laufendes Geschäftsjahr (ab {b.fiscalYearStart})</td><td className="text-right">{money(b.currentResult)}</td></tr>
            <tr className="font-semibold"><td className="pt-3">Summe Passiva</td><td className="pt-3 text-right">{money(b.passivaTotal)}</td></tr>
            <tr><td className="pt-3">Differenz Aktiva − Passiva</td><td className={`pt-3 text-right ${b.difference.isZero() ? "" : "font-semibold text-red-700 dark:text-red-300"}`}>{money(b.difference)}</td></tr>
          </tbody></table>
        </div>
      );
    } else {
      if (!sp.account) body = <p className="text-sm text-muted">Bitte ein Konto wählen.</p>;
      else {
        const l = await accountLedger(ctx, sp.account, { from, to });
        body = (
          <div className="space-y-2"><h2 className="font-medium">{l.account.number} {l.account.name}</h2>
            <table className="w-full text-left text-sm"><caption className="sr-only">Kontoblatt</caption>
              <thead className="text-muted"><tr><th scope="col" className="py-2">Datum</th><th scope="col">Nr.</th><th scope="col">Text</th><th scope="col" className="text-right">Soll</th><th scope="col" className="text-right">Haben</th><th scope="col" className="text-right">Saldo</th></tr></thead>
              <tbody className="divide-y divide-line">
                <tr><td className="py-1.5" colSpan={5}>Saldo vor dem Zeitraum</td><td className="text-right">{money(l.opening)}</td></tr>
                {l.rows.map((r, i) => <tr key={i}><td className="py-1.5">{r.entry.entryDate.toISOString().slice(0, 10)}</td><td>{r.entry.number}</td><td>{r.entry.text}</td><td className="text-right">{r.debit.gt(0) ? money(r.debit) : ""}</td><td className="text-right">{r.credit.gt(0) ? money(r.credit) : ""}</td><td className="text-right">{money(r.balance)}</td></tr>)}
              </tbody>
              <tfoot><tr className="font-medium"><td className="py-2" colSpan={5}>Saldo am Ende</td><td className="text-right">{money(l.closing)}</td></tr></tfoot>
            </table>
          </div>
        );
      }
    }
  } catch (e) {
    if (e instanceof ConflictError || e instanceof NotFoundError || e instanceof ForbiddenError) error = e.message || "Nicht verfügbar";
    else throw e;
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div><p className="text-sm"><Link className="text-accent underline" href="/finance/ledger">← Hauptbuch</Link></p><h1 className="text-2xl font-semibold tracking-tight">Auswertungen</h1></div>
      <ErrorBanner message={error} />
      <nav aria-label="Berichte" className="flex gap-4 text-sm">{TABS.map(([k, label]) => <Link key={k} href={`/finance/ledger/reports?tab=${k}&from=${from}&to=${to}${sp.account ? `&account=${sp.account}` : ""}`} aria-current={tab === k ? "page" : undefined} className={tab === k ? "font-semibold underline" : "text-accent underline"}>{label}</Link>)}</nav>
      <form className="flex flex-wrap items-end gap-3 text-sm"><input type="hidden" name="tab" value={tab} />
        {tab !== "bs" && <label>Von<input type="date" name="from" defaultValue={from} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>}
        <label>{tab === "bs" ? "Stichtag" : "Bis"}<input type="date" name="to" defaultValue={to} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
        {tab === "ledger" && <label>Konto<select name="account" defaultValue={sp.account ?? ""} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1"><option value="">–</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>}
        <button className="rounded-md border border-line px-3 py-1.5">Anzeigen</button>
      </form>
      {body}
    </div>
  );
}
