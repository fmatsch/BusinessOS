import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createOrder, listOrders } from "@/modules/sales/service";
import { listCrmCustomers } from "@/modules/crm/service";
import { listTaxCodes } from "@/modules/finance/service";
import { listItems } from "@/modules/inventory/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/sales";
const LINES = 4;
const STATUS: Record<string, string> = { DRAFT: "Entwurf", CONFIRMED: "bestätigt", CLOSED: "erledigt", CANCELLED: "storniert" };

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const lines = Array.from({ length: LINES }, (_, i) => ({
    itemId: fd.get(`item${i}`), description: String(fd.get(`desc${i}`) ?? "").trim(), quantity: String(fd.get(`qty${i}`) ?? "").replace(",", "."), unitPrice: String(fd.get(`price${i}`) ?? "").replace(",", "."), taxCodeId: fd.get(`tax${i}`),
  })).filter((l) => l.description !== "" || l.quantity !== "" || l.unitPrice !== "");
  const o = await runAction(BACK, () => createOrder(ctx, { customerId: fd.get("customerId"), reference: fd.get("reference"), orderDate: fd.get("orderDate"), note: fd.get("note"), lines }));
  redirect(`/sales/${o.id}`);
}

export default async function SalesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let orders;
  try { orders = await listOrders(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const creator = can(ctx, "sales.order.manage");
  const [customers, taxCodes, items] = creator ? await Promise.all([listCrmCustomers(ctx), listTaxCodes(ctx), listItems(ctx)]) : [[], [], []];
  const tax = taxCodes.filter((t) => t.direction === "OUTPUT" && t.active);
  const today = new Date().toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Aufträge und Lieferung</h1>
        <p className="text-sm text-muted">Kundenaufträge bestätigen, ausliefern (Lagerabgang mit Lagerort, Charge, Seriennummern), Lieferschein drucken und gelieferte Mengen abrechnen (Rechnungsentwurf). Nicht enthalten: Reservierungen, Preislisten, Rabatte, Frachtkosten, Versandetiketten.</p>
      </div>
      <ErrorBanner message={error} />
      {creator && (
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Auftrag anlegen">
          <h2 className="font-medium">Auftrag anlegen</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="sm:col-span-2">Kunde<select name="customerId" required className={input}><option value="">–</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.number} {c.name}</option>)}</select></label>
            <label>Datum<input type="date" name="orderDate" defaultValue={today} required className={input} /></label>
            <label>Referenz<input name="reference" maxLength={80} className={input} /></label>
          </div>
          {Array.from({ length: LINES }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-6">
              <label>Artikel {i + 1}<select name={`item${i}`} className={input}><option value="">Leistung</option>{items.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.number} {x.name}</option>)}</select></label>
              <label className="sm:col-span-2">Bezeichnung {i + 1}<input name={`desc${i}`} maxLength={200} className={input} /></label>
              <label>Menge {i + 1}<input name={`qty${i}`} inputMode="decimal" className={input} /></label>
              <label>Preis {i + 1}<input name={`price${i}`} inputMode="decimal" className={input} /></label>
              <label>Steuer {i + 1}<select name={`tax${i}`} className={input}>{tax.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
            </div>
          ))}
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Auftrag anlegen</button>
        </form>
      )}
      {orders.length === 0 ? <p className="text-sm text-muted">Noch keine Aufträge.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Aufträge</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Nummer</th><th scope="col">Kunde</th><th scope="col">Referenz</th><th scope="col">Status</th><th scope="col" className="text-right">Netto</th></tr></thead>
          <tbody className="divide-y divide-line">
            {orders.map((o) => (
              <tr key={o.id}><td className="py-1.5"><Link className="text-accent underline" href={`/sales/${o.id}`}>{o.number ?? "Entwurf"}</Link></td><td>{o.customerName}</td><td>{o.reference ?? ""}</td><td>{STATUS[o.status]}</td><td className="text-right">{formatMoney(o.net.toString())}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
