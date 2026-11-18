import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { billOrder, cancelDelivery, cancelOrder, confirmOrder, createDelivery, discardDelivery, getOrder, shipDelivery } from "@/modules/sales/service";
import { listLocations } from "@/modules/inventory/service";
import { Decimal, formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const here = (id: string) => `/sales/${id}`;
const STATUS: Record<string, string> = { DRAFT: "Entwurf", CONFIRMED: "bestätigt", CLOSED: "erledigt", CANCELLED: "storniert", SHIPPED: "versandt" };
const num = (v: FormDataEntryValue | null) => String(v ?? "").replace(",", ".");

async function confirm(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => confirmOrder(ctx, id)); revalidatePath(here(id)); }
async function cancel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => cancelOrder(ctx, id)); revalidatePath(here(id)); }
async function bill(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  const r = await runAction(here(id), () => billOrder(ctx, id));
  redirect(`/finance/out/${r.invoiceId}`);
}
async function newDelivery(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  const lines = [...fd.keys()].filter((k) => k.startsWith("qty_")).map((k) => k.slice(4)).filter((l) => num(fd.get(`qty_${l}`)) !== "").map((l) => ({
    orderLineId: l, quantity: num(fd.get(`qty_${l}`)), locationId: fd.get(`loc_${l}`), batchNumber: fd.get(`batch_${l}`), serials: fd.get(`serials_${l}`),
  }));
  await runAction(here(id), () => createDelivery(ctx, { orderId: id, carrier: fd.get("carrier"), trackingNumber: fd.get("trackingNumber"), note: fd.get("note"), lines }));
  revalidatePath(here(id));
}
async function ship(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("orderId")); await runAction(here(id), () => shipDelivery(ctx, String(fd.get("deliveryId")), { shippedOn: fd.get("shippedOn") })); revalidatePath(here(id)); }
async function discard(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("orderId")); await runAction(here(id), () => discardDelivery(ctx, String(fd.get("deliveryId")))); revalidatePath(here(id)); }
async function cancelDel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("orderId")); await runAction(here(id), () => cancelDelivery(ctx, String(fd.get("deliveryId")), String(fd.get("reason") ?? ""))); revalidatePath(here(id)); }

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let order;
  try { order = await getOrder(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "sales.order.manage"), deliver = can(ctx, "sales.delivery.manage"), biller = can(ctx, "sales.bill");
  const locations = deliver && can(ctx, "inventory.read") ? (await listLocations(ctx)).filter((l) => l.active) : [];
  const today = new Date().toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const net = order.lines.reduce((s, l) => s.plus(new Decimal(l.quantity.toString()).times(l.unitPrice.toString())), new Decimal(0));
  const openLines = order.lines.filter((l) => l.open.gt(0));
  const unbilled = order.deliveries.some((d) => d.status === "SHIPPED" && d.lines.some((l) => !l.invoiceId));

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/sales">← Aufträge</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Auftrag {order.number ?? "(Entwurf)"} · {STATUS[order.status]}</h1>
        <p className="text-sm text-muted">Kunde {order.customerName}{order.reference ? ` · Referenz ${order.reference}` : ""} · Netto {formatMoney(net.toString())}</p>
      </div>
      <ErrorBanner message={error} />
      <div className="flex flex-wrap gap-3 text-sm">
        {manage && order.status === "DRAFT" && <form action={confirm}><input type="hidden" name="id" value={order.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Bestätigen</button></form>}
        {manage && (order.status === "DRAFT" || order.status === "CONFIRMED") && <form action={cancel}><input type="hidden" name="id" value={order.id} /><button className="rounded-md border border-line px-3 py-1.5">Auftrag stornieren</button></form>}
        {biller && unbilled && (order.status === "CONFIRMED" || order.status === "CLOSED") && <form action={bill}><input type="hidden" name="id" value={order.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Gelieferte Mengen abrechnen</button></form>}
      </div>

      <table className="w-full text-left text-sm">
        <caption className="sr-only">Positionen</caption>
        <thead className="text-muted"><tr><th scope="col" className="py-2">Pos.</th><th scope="col">Bezeichnung</th><th scope="col" className="text-right">Menge</th><th scope="col" className="text-right">Preis</th><th scope="col" className="text-right">Geliefert</th><th scope="col" className="text-right">Abgerechnet</th></tr></thead>
        <tbody className="divide-y divide-line">
          {order.lines.map((l) => (
            <tr key={l.id}><td className="py-1.5">{l.position}</td><td>{l.item ? `${l.item.number} · ` : ""}{l.description}</td><td className="text-right">{l.quantity.toString()}</td><td className="text-right">{formatMoney(l.unitPrice.toString())}</td><td className="text-right">{l.shipped.toString()}</td><td className="text-right">{l.billed.toString()}</td></tr>
          ))}
        </tbody>
      </table>

      {deliver && order.status === "CONFIRMED" && openLines.length > 0 && (
        <form action={newDelivery} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Lieferung anlegen">
          <input type="hidden" name="id" value={order.id} />
          <h2 className="font-medium">Lieferung anlegen</h2>
          {openLines.map((l) => (
            <div key={l.id} className="grid gap-2 sm:grid-cols-5">
              <p className="self-end">{l.position}. {l.description} (offen {l.open.toString()})</p>
              <label>Menge (Pos. {l.position})<input name={`qty_${l.id}`} inputMode="decimal" className={input} /></label>
              {l.item ? (
                <>
                  <label>Lagerort (Pos. {l.position})<select name={`loc_${l.id}`} className={input}><option value="">Ohne Lagerort</option>{locations.map((x) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}</select></label>
                  <label>Charge (Pos. {l.position})<input name={`batch_${l.id}`} maxLength={40} disabled={l.item.tracking !== "BATCH"} className={input} /></label>
                  <label>Seriennummern (Pos. {l.position})<input name={`serials_${l.id}`} disabled={l.item.tracking !== "SERIAL"} className={input} /></label>
                </>
              ) : <p className="self-end text-muted sm:col-span-3">Leistung – keine Lagerbewegung</p>}
            </div>
          ))}
          <div className="grid gap-2 sm:grid-cols-3">
            <label>Spediteur<input name="carrier" maxLength={60} className={input} /></label>
            <label>Sendungsnummer<input name="trackingNumber" maxLength={80} className={input} /></label>
            <label>Notiz<input name="note" maxLength={500} className={input} /></label>
          </div>
          <button className="rounded-md border border-line px-3 py-1.5">Lieferung als Entwurf anlegen</button>
        </form>
      )}

      <section aria-label="Lieferungen" className="space-y-3">
        <h2 className="font-medium">Lieferungen</h2>
        {order.deliveries.length === 0 ? <p className="text-sm text-muted">Noch keine Lieferungen.</p> : order.deliveries.map((dl) => (
          <div key={dl.id} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
            <p className="font-medium">{dl.number ?? "Entwurf"} · {STATUS[dl.status] ?? dl.status}{dl.shippedOn ? ` am ${dl.shippedOn.toISOString().slice(0, 10)}` : ""}{dl.carrier ? ` · ${dl.carrier}` : ""}{dl.trackingNumber ? ` · Sendung ${dl.trackingNumber}` : ""}{dl.cancelReason ? ` · Grund: ${dl.cancelReason}` : ""}</p>
            <p className="text-muted">{dl.lines.map((l) => `${order.lines.find((x) => x.id === l.orderLineId)?.description ?? "?"}: ${l.quantity.toString()}${l.invoiceId ? " (abgerechnet)" : ""}`).join(" · ")}</p>
            <div className="flex flex-wrap items-end gap-3">
              {dl.status !== "DRAFT" && <Link className="text-accent underline" href={`/sales/deliveries/${dl.id}`}>Lieferschein</Link>}
              {deliver && dl.status === "DRAFT" && (
                <>
                  <form action={ship} className="flex flex-wrap items-end gap-2" aria-label={`Versand ${dl.id}`}>
                    <input type="hidden" name="orderId" value={order.id} /><input type="hidden" name="deliveryId" value={dl.id} />
                    <label>Versanddatum<input type="date" name="shippedOn" defaultValue={today} required className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
                    <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Versenden und Lager buchen</button>
                  </form>
                  <form action={discard}><input type="hidden" name="orderId" value={order.id} /><input type="hidden" name="deliveryId" value={dl.id} /><button className="rounded-md border border-line px-3 py-1.5">Entwurf verwerfen</button></form>
                </>
              )}
              {deliver && dl.status === "SHIPPED" && !dl.lines.some((l) => l.invoiceId) && (
                <form action={cancelDel} className="flex items-end gap-2"><input type="hidden" name="orderId" value={order.id} /><input type="hidden" name="deliveryId" value={dl.id} />
                  <label>Storno-Grund<input name="reason" required minLength={3} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
                  <button className="rounded-md border border-line px-3 py-1.5">Lieferung stornieren</button></form>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
