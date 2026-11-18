import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createQuote, decideQuote, listCrmCustomers, listPendingQuoteApprovals, listQuotes } from "@/modules/crm/service";
import { displayStatus, type QuoteStatus } from "@/modules/crm/quote-rules";
import { listTaxCodes } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/crm/quotes";
const LINES = 3;

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const lines = Array.from({ length: LINES }, (_, i) => ({ description: String(fd.get(`desc${i}`) ?? "").trim(), quantity: String(fd.get(`qty${i}`) ?? ""), unitPrice: String(fd.get(`price${i}`) ?? ""), taxCodeId: fd.get(`tax${i}`) }))
    .filter((l) => l.description !== "" || l.quantity !== "" || l.unitPrice !== "");
  const q = await runAction(BACK, () => createQuote(ctx, { customerId: fd.get("customerId"), title: fd.get("title"), validUntil: fd.get("validUntil"), note: fd.get("note"), lines }));
  redirect(`/crm/quotes/${q.id}`);
}
async function decide(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => decideQuote(ctx, { quoteId: fd.get("quoteId"), decision: fd.get("decision"), comment: fd.get("comment") }));
  revalidatePath(BACK);
}

export default async function QuotesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let quotes;
  try { quotes = await listQuotes(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const creator = can(ctx, "crm.quote.create");
  const [pending, customers, taxCodes] = await Promise.all([
    listPendingQuoteApprovals(ctx),
    creator ? listCrmCustomers(ctx) : Promise.resolve([]),
    creator && can(ctx, "finance.master.read") ? listTaxCodes(ctx) : Promise.resolve([]),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const tax = taxCodes.filter((t) => t.direction === "OUTPUT" && t.active);

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/crm">← CRM</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Angebote</h1>
        <p className="text-sm text-muted">Jedes Angebot braucht eine Freigabe laut Freigaberegel (Vier-Augen) und wird erst mit dem Versenden nummeriert. Angebote werden nicht bearbeitet; Änderungen gehen als Kopie.</p>
      </div>
      <ErrorBanner message={error} />

      {pending.length > 0 && (
        <section className="space-y-2" aria-label="Zur Freigabe">
          <h2 className="font-medium">Zur Freigabe</h2>
          <ul className="space-y-2">
            {pending.map((a) => (
              <li key={a.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
                <Link className="font-medium text-accent underline" href={`/crm/quotes/${a.quote.id}`}>{a.quote.title}</Link> · {a.quote.customer.name} · {formatMoney(a.quote.grossTotal.toString(), a.quote.currency)} brutto · Schritt: {a.label}
                <form action={decide} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="quoteId" value={a.quote.id} />
                  <label>Kommentar<input name="comment" maxLength={300} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
                  <button name="decision" value="APPROVE" className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Freigeben</button>
                  <button name="decision" value="REJECT" className="rounded-md border border-line px-3 py-1.5">Ablehnen (Begründung nötig)</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {creator && (
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-medium">Angebot anlegen (Entwurf)</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label>Kunde<select name="customerId" required className={input}><option value="">–</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.number} {c.name}</option>)}</select></label>
            <label>Titel<input name="title" required maxLength={120} className={input} /></label>
            <label>Gültig bis<input type="date" name="validUntil" required min={today} className={input} /></label>
            <label>Hinweis<input name="note" maxLength={300} className={input} /></label>
          </div>
          {Array.from({ length: LINES }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-5">
              <input name={`desc${i}`} placeholder={`Position ${i + 1}`} aria-label={`Beschreibung ${i + 1}`} maxLength={200} className={input + " sm:col-span-2"} />
              <input name={`qty${i}`} inputMode="decimal" placeholder="Menge" aria-label={`Menge ${i + 1}`} className={input} />
              <input name={`price${i}`} inputMode="decimal" placeholder="Einzelpreis netto" aria-label={`Einzelpreis ${i + 1}`} className={input} />
              <select name={`tax${i}`} aria-label={`Steuerkennzeichen ${i + 1}`} className={input}><option value="">Steuer …</option>{tax.map((t) => <option key={t.id} value={t.id}>{t.key} ({t.rate.toString()} %)</option>)}</select>
            </div>
          ))}
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Entwurf anlegen</button>
        </form>
      )}

      {quotes.length === 0 ? <p className="text-sm text-muted">Noch keine Angebote.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Nummer</th><th>Titel</th><th>Kunde</th><th>Gültig bis</th><th className="text-right">Brutto</th><th>Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {quotes.map((q) => (
              <tr key={q.id}>
                <td className="py-2"><Link className="text-accent underline" href={`/crm/quotes/${q.id}`}>{q.number ?? "Entwurf"}</Link></td><td>{q.title}</td><td>{q.customer.name}</td>
                <td>{q.validUntil.toISOString().slice(0, 10)}</td><td className="text-right">{formatMoney(q.grossTotal.toString(), q.currency)}</td>
                <td>{displayStatus(q.status as QuoteStatus, q.validUntil.toISOString().slice(0, 10), today)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
