import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { listAccounts, listCustomers, listTaxCodes } from "@/modules/finance/service";
import { createRecurring, listRecurring, runRecurringInvoices, setRecurringActive } from "@/modules/finance/recurring-invoices";
import { INTERVAL_LABEL, type Interval } from "@/modules/finance/recurring";
import { redirect } from "next/navigation";
import { Decimal, formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/finance/recurring";
const LINES = 3;

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const lines = Array.from({ length: LINES }, (_, i) => ({
    description: String(fd.get(`desc${i}`) ?? "").trim(), quantity: String(fd.get(`qty${i}`) ?? ""), unitPrice: String(fd.get(`price${i}`) ?? ""), taxCodeId: fd.get(`tax${i}`), revenueAccountId: fd.get(`acc${i}`) || null,
  })).filter((l) => l.description !== "" || l.quantity !== "" || l.unitPrice !== "");
  await runAction(BACK, () => createRecurring(ctx, { customerId: fd.get("customerId"), title: fd.get("title"), interval: fd.get("interval"), firstRunOn: fd.get("firstRunOn"), endsOn: fd.get("endsOn"), note: fd.get("note"), lines }));
  revalidatePath(BACK);
}
async function toggle(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setRecurringActive(ctx, String(fd.get("id")), fd.get("active") === "true")); revalidatePath(BACK); }
async function run() {
  "use server";
  const ctx = await requireContext();
  const r = await runAction(BACK, () => runRecurringInvoices(ctx));
  revalidatePath(BACK);
  const q = new URLSearchParams({ made: String(r.created.length) });
  if (r.failed.length) q.set("error", r.failed.map((f) => `${f.title}: ${f.error}`).join(" · "));
  redirect(`${BACK}?${q}`);
}

export default async function RecurringPage({ searchParams }: { searchParams: Promise<{ error?: string; made?: string }> }) {
  const { error, made } = await searchParams;
  const ctx = await requireContext();
  let list;
  try { list = await listRecurring(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "finance.recurring.manage");
  const [customers, taxCodes, accounts] = manage && can(ctx, "finance.master.read") ? await Promise.all([listCustomers(ctx), listTaxCodes(ctx), listAccounts(ctx)]) : [[], [], []];
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const tax = taxCodes.filter((t) => t.direction === "OUTPUT" && t.active);
  const gl = accounts.filter((a) => a.type === "GL" && a.active);

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wiederkehrende Rechnungen</h1>
        <p className="text-sm text-muted">Vorlagen für Wartung, Miete, Abos. „Fällige Entwürfe erzeugen“ legt je fälligem Termin einen <strong>Entwurf</strong> an (nachgeholt höchstens 12 je Vorlage); ausgestellt wird erst nach Prüfung. Der Lauf startet nicht von selbst.</p>
      </div>
      <ErrorBanner message={error} />
      {made !== undefined && <p role="status" className="text-sm">{made} Entwürfe erzeugt.</p>}
      {manage && (
        <form action={run}><button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg">Fällige Entwürfe erzeugen</button></form>
      )}
      {manage && (
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-medium">Vorlage anlegen</h2>
          <div className="grid gap-3 sm:grid-cols-6">
            <label className="sm:col-span-2">Kunde<select name="customerId" required className={input}><option value="">–</option>{customers.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.number} {c.name}</option>)}</select></label>
            <label className="sm:col-span-2">Bezeichnung<input name="title" required maxLength={120} className={input} /></label>
            <label>Rhythmus<select name="interval" className={input}>{(Object.keys(INTERVAL_LABEL) as Interval[]).map((k) => <option key={k} value={k}>{INTERVAL_LABEL[k]}</option>)}</select></label>
            <label>Erstes Rechnungsdatum<input type="date" name="firstRunOn" required className={input} /></label>
            <label>Ende (optional)<input type="date" name="endsOn" className={input} /></label>
            <label className="sm:col-span-3">Hinweis auf der Rechnung<input name="note" maxLength={300} className={input} /></label>
          </div>
          {Array.from({ length: LINES }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-6">
              <input name={`desc${i}`} placeholder={`Position ${i + 1}`} aria-label={`Beschreibung ${i + 1}`} maxLength={200} className={input + " sm:col-span-2"} />
              <input name={`qty${i}`} inputMode="decimal" placeholder="Menge" aria-label={`Menge ${i + 1}`} className={input} />
              <input name={`price${i}`} inputMode="decimal" placeholder="Einzelpreis netto" aria-label={`Einzelpreis ${i + 1}`} className={input} />
              <select name={`tax${i}`} aria-label={`Steuerkennzeichen ${i + 1}`} className={input}><option value="">Steuer …</option>{tax.map((t) => <option key={t.id} value={t.id}>{t.key} ({t.rate.toString()} %)</option>)}</select>
              <select name={`acc${i}`} aria-label={`Erlöskonto ${i + 1}`} className={input}><option value="">Konto (Standard des Kunden)</option>{gl.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select>
            </div>
          ))}
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Vorlage speichern</button>
        </form>
      )}
      {list.length === 0 ? <p className="text-sm text-muted">Noch keine Vorlagen.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Bezeichnung</th><th>Kunde</th><th>Rhythmus</th><th>Nächster Lauf</th><th>Ende</th><th className="text-right">Netto je Lauf</th><th>Status</th>{manage && <th />}</tr></thead>
          <tbody className="divide-y divide-line">
            {list.map((r) => {
              const net = r.lines.reduce((a, l) => a.plus(new Decimal(l.quantity.toString()).times(l.unitPrice.toString()).toDecimalPlaces(2)), new Decimal(0));
              return (
                <tr key={r.id}>
                  <td className="py-2">{r.title}</td><td>{r.customer.name}</td><td>{INTERVAL_LABEL[r.interval as Interval]}</td>
                  <td>{r.nextRunOn.toISOString().slice(0, 10)}</td><td>{r.endsOn ? r.endsOn.toISOString().slice(0, 10) : "–"}</td>
                  <td className="text-right">{formatMoney(net.toString())}</td><td>{r.active ? "aktiv" : "pausiert"}</td>
                  {manage && <td><form action={toggle}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="active" value={String(!r.active)} /><button className="rounded-md border border-line px-2 py-0.5">{r.active ? "Pausieren" : "Fortsetzen"}</button></form></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="text-sm"><Link className="text-accent underline" href="/finance/out">Zu den Ausgangsrechnungen</Link></p>
    </div>
  );
}
