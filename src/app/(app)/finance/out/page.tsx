import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { listCostCenters } from "@/modules/masterdata/service";
import { createCustomerInvoice, listAccounts, listCustomerInvoices, listCustomers, listTaxCodes } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const LINES = 3;
const STATUS: Record<string, string> = { DRAFT: "Entwurf", ISSUED: "ausgestellt", CANCELLED: "verworfen" };

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const lines = Array.from({ length: LINES }, (_, i) => ({
    description: String(fd.get(`desc${i}`) ?? "").trim(), quantity: String(fd.get(`qty${i}`) ?? ""), unitPrice: String(fd.get(`price${i}`) ?? ""), taxCodeId: fd.get(`tax${i}`),
    revenueAccountId: fd.get(`acc${i}`) || null, costCenterId: fd.get(`cc${i}`) || null,
  })).filter((l) => l.description !== "" || l.quantity !== "" || l.unitPrice !== "");
  const inv = await runAction("/finance/out", () => createCustomerInvoice(ctx, { customerId: fd.get("customerId"), invoiceDate: fd.get("invoiceDate"), dueDate: fd.get("dueDate"), note: fd.get("note"), lines }));
  redirect(`/finance/out/${inv.id}`);
}

export default async function CustomerInvoices({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "finance.invoice.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const creator = can(ctx, "finance.invoice.out.create");
  const [invoices, customers, taxCodes, accounts, costCenters] = await Promise.all([
    listCustomerInvoices(ctx),
    creator ? listCustomers(ctx) : Promise.resolve([]),
    creator ? listTaxCodes(ctx) : Promise.resolve([]),
    creator ? listAccounts(ctx) : Promise.resolve([]),
    creator && can(ctx, "master.costcenter.read") ? listCostCenters(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const gl = accounts.filter((a) => a.type === "GL" && a.active);
  const tax = taxCodes.filter((t) => t.direction === "OUTPUT" && t.active);

  return (
    <div className="max-w-6xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Ausgangsrechnungen</h1>
      <ErrorBanner message={error} />
      {creator && (
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-medium">Rechnung anlegen (Entwurf)</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label>Kunde<select name="customerId" required className={input}><option value="">–</option>{customers.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.number} {c.name}</option>)}</select></label>
            <label>Rechnungsdatum<input type="date" name="invoiceDate" required className={input} /></label>
            <label>Fällig am (Standard: Zahlungsziel)<input type="date" name="dueDate" className={input} /></label>
            <label>Hinweis<input name="note" maxLength={300} className={input} /></label>
          </div>
          {Array.from({ length: LINES }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-6">
              <input name={`desc${i}`} placeholder={`Position ${i + 1}`} aria-label={`Beschreibung ${i + 1}`} maxLength={200} className={input + " sm:col-span-2"} />
              <input name={`qty${i}`} inputMode="decimal" placeholder="Menge" aria-label={`Menge ${i + 1}`} className={input} />
              <input name={`price${i}`} inputMode="decimal" placeholder="Einzelpreis netto" aria-label={`Einzelpreis ${i + 1}`} className={input} />
              <select name={`tax${i}`} aria-label={`Steuerkennzeichen ${i + 1}`} className={input}><option value="">Steuer …</option>{tax.map((t) => <option key={t.id} value={t.id}>{t.key} ({t.rate.toString()} %)</option>)}</select>
              <select name={`acc${i}`} aria-label={`Erlöskonto ${i + 1}`} className={input}><option value="">Konto (Standard des Kunden)</option>{gl.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select>
              <input type="hidden" name={`cc${i}`} value="" />
            </div>
          ))}
          {costCenters.length === 0 ? null : <p className="text-xs text-muted">Kostenstellen für Ausgangsrechnungen folgen mit dem Projekt-Modul.</p>}
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Entwurf anlegen</button>
        </form>
      )}
      {invoices.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Nummer</th><th>Kunde</th><th>Datum</th><th className="text-right">Brutto</th><th>Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {invoices.map((i) => (
              <tr key={i.id}>
                <td className="py-2"><Link className="text-accent underline" href={`/finance/out/${i.id}`}>{i.number ?? "Entwurf"}</Link></td>
                <td>{i.customer.name}</td><td>{i.invoiceDate.toISOString().slice(0, 10)}</td>
                <td className="text-right">{formatMoney(i.grossTotal.toString(), i.currency)}{i.kind === "CREDIT" ? " (Gutschrift)" : ""}</td>
                <td>{STATUS[i.status]}{i.paidOn ? " · bezahlt" : ""}{i.exported ? " · exportiert" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
