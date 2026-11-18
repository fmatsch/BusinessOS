import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { listCostCenters } from "@/modules/masterdata/service";
import { listOrders, listSuppliers } from "@/modules/procurement/service";
import { createSupplierInvoice, listAccounts, listSupplierInvoices, listTaxCodes, uploadFile } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const LINES = 3;
const STATUS: Record<string, string> = { DRAFT: "wartet auf Freigabe", APPROVED: "freigegeben", CANCELLED: "storniert" };

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const file = fd.get("file");
  let fileId: string | null = null;
  if (file instanceof File && file.size > 0) {
    const up = await runAction("/finance/in", async () => uploadFile(ctx, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }));
    fileId = up.id;
  }
  const lines = Array.from({ length: LINES }, (_, i) => ({
    description: String(fd.get(`desc${i}`) ?? "").trim(), netAmount: String(fd.get(`net${i}`) ?? ""), taxCodeId: fd.get(`tax${i}`), expenseAccountId: fd.get(`acc${i}`) || null, costCenterId: fd.get(`cc${i}`) || null,
  })).filter((l) => l.description !== "" || l.netAmount !== "");
  const inv = await runAction("/finance/in", () => createSupplierInvoice(ctx, {
    supplierId: fd.get("supplierId"), invoiceNumber: fd.get("invoiceNumber"), invoiceDate: fd.get("invoiceDate"), dueDate: fd.get("dueDate"),
    kind: fd.get("kind") || "INVOICE", creditsId: fd.get("creditsId") || null, purchaseOrderId: fd.get("purchaseOrderId") || null, fileId, note: fd.get("note"), lines,
  }));
  redirect(`/finance/in/${inv.id}`);
}

export default async function SupplierInvoices({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "finance.invoice.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const creator = can(ctx, "finance.invoice.in.create");
  const [invoices, suppliers, taxCodes, accounts, costCenters, orders] = await Promise.all([
    listSupplierInvoices(ctx),
    creator ? listSuppliers(ctx) : Promise.resolve([]),
    creator ? listTaxCodes(ctx) : Promise.resolve([]),
    creator ? listAccounts(ctx) : Promise.resolve([]),
    creator && can(ctx, "master.costcenter.read") ? listCostCenters(ctx) : Promise.resolve([]),
    creator && can(ctx, "procurement.order.create") ? listOrders(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const gl = accounts.filter((a) => a.type === "GL" && a.active);
  const tax = taxCodes.filter((t) => t.direction === "INPUT" && t.active);
  const approved = invoices.filter((i) => i.status === "APPROVED" && i.kind === "INVOICE");

  return (
    <div className="max-w-6xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Eingangsrechnungen</h1>
      <ErrorBanner message={error} />
      {creator && (
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-medium">Rechnung erfassen</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label>Lieferant<select name="supplierId" required className={input}><option value="">–</option>{suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.number} {s.name}</option>)}</select></label>
            <label>Rechnungsnummer<input name="invoiceNumber" required maxLength={35} className={input} /></label>
            <label>Rechnungsdatum<input type="date" name="invoiceDate" required className={input} /></label>
            <label>Fällig am<input type="date" name="dueDate" className={input} /></label>
            <label>Art<select name="kind" className={input}><option value="INVOICE">Rechnung</option><option value="CREDIT">Gutschrift</option></select></label>
            <label>Bestellung (optional, für den Abgleich)<select name="purchaseOrderId" className={input}><option value="">–</option>{orders.filter((o) => o.status !== "CANCELLED").map((o) => <option key={o.id} value={o.id}>{o.number} · {o.supplier.name}</option>)}</select></label>
            <label>Bezug (nur Gutschrift)<select name="creditsId" className={input}><option value="">–</option>{approved.map((i) => <option key={i.id} value={i.id}>{i.supplier.name} {i.invoiceNumber}</option>)}</select></label>
            <label className="sm:col-span-2">Belegdatei (PDF, PNG, JPEG, max. 8 MB)<input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" className={input} /></label>
          </div>
          {Array.from({ length: LINES }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-5">
              <input name={`desc${i}`} placeholder={`Position ${i + 1}`} aria-label={`Beschreibung ${i + 1}`} maxLength={200} className={input} />
              <input name={`net${i}`} inputMode="decimal" placeholder="Netto" aria-label={`Netto ${i + 1}`} className={input} />
              <select name={`tax${i}`} aria-label={`Steuerkennzeichen ${i + 1}`} className={input}><option value="">Steuer …</option>{tax.map((t) => <option key={t.id} value={t.id}>{t.key} ({t.rate.toString()} %)</option>)}</select>
              <select name={`acc${i}`} aria-label={`Aufwandskonto ${i + 1}`} className={input}><option value="">Konto (Standard des Lieferanten)</option>{gl.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select>
              <select name={`cc${i}`} aria-label={`Kostenstelle ${i + 1}`} className={input}><option value="">Kostenstelle</option>{costCenters.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select>
            </div>
          ))}
          <label className="block">Hinweis<input name="note" maxLength={300} className={input} /></label>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Rechnung erfassen</button>
        </form>
      )}
      {invoices.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Beleg</th><th>Lieferant</th><th>Nr. des Lieferanten</th><th>Datum</th><th className="text-right">Brutto</th><th>Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {invoices.map((i) => (
              <tr key={i.id}>
                <td className="py-2"><Link className="text-accent underline" href={`/finance/in/${i.id}`}>{i.voucherNumber ?? "Entwurf"}</Link></td>
                <td>{i.supplier.name}</td><td>{i.invoiceNumber}{i.kind === "CREDIT" ? " (Gutschrift)" : ""}</td><td>{i.invoiceDate.toISOString().slice(0, 10)}</td>
                <td className="text-right">{formatMoney(i.grossTotal.toString(), i.currency)}</td>
                <td>{STATUS[i.status]}{i.paidOn ? " · bezahlt" : ""}{i.exported ? " · exportiert" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
