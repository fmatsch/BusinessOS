import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { cancelProductionOrder, completeProductionOrder, confirmProduction, getProductionOrder, releaseProductionOrder, reverseConfirmation } from "@/modules/production/service";
import { listLocations } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const here = (id: string) => `/production/${id}`;
const STATUS: Record<string, string> = { DRAFT: "Entwurf", RELEASED: "freigegeben", COMPLETED: "fertig", CANCELLED: "storniert" };
const num = (v: FormDataEntryValue | null) => String(v ?? "").replace(",", ".");

async function release(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => releaseProductionOrder(ctx, id)); revalidatePath(here(id)); }
async function cancel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => cancelProductionOrder(ctx, id)); revalidatePath(here(id)); }
async function complete(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => completeProductionOrder(ctx, id)); revalidatePath(here(id)); }
async function confirm(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  await runAction(here(id), () => confirmProduction(ctx, { orderId: id, quantity: num(fd.get("quantity")), componentLocationId: fd.get("componentLocationId"), outputLocationId: fd.get("outputLocationId"), batchNumber: fd.get("batchNumber"), expiresOn: fd.get("expiresOn"), serials: fd.get("serials") }));
  revalidatePath(here(id));
}
async function reverse(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => reverseConfirmation(ctx, String(fd.get("confirmationId")), String(fd.get("reason") ?? ""))); revalidatePath(here(id)); }

export default async function ProductionOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let o;
  try { o = await getProductionOrder(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "production.order.manage"), confirmer = can(ctx, "production.confirm");
  const locations = confirmer && can(ctx, "inventory.read") ? (await listLocations(ctx)).filter((l) => l.active) : [];
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const tracked = o.item.tracking;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/production">← Fertigung</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Fertigungsauftrag {o.number ?? "(Entwurf)"} · {STATUS[o.status]}</h1>
        <p className="text-sm text-muted">{o.item.number} {o.item.name} · geplant {o.quantity.toString()} {o.item.unit}, gefertigt {o.produced.toString()}, offen {o.remaining.toString()} · Stückliste Version {o.bom.version}</p>
      </div>
      <ErrorBanner message={error} />
      <div className="flex flex-wrap gap-3 text-sm">
        {manage && o.status === "DRAFT" && <form action={release}><input type="hidden" name="id" value={o.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Freigeben</button></form>}
        {manage && (o.status === "DRAFT" || o.status === "RELEASED") && <form action={cancel}><input type="hidden" name="id" value={o.id} /><button className="rounded-md border border-line px-3 py-1.5">Auftrag stornieren</button></form>}
        {manage && o.status === "RELEASED" && o.produced.gt(0) && <form action={complete}><input type="hidden" name="id" value={o.id} /><button className="rounded-md border border-line px-3 py-1.5">Mit Teilmenge abschließen</button></form>}
      </div>

      <table className="w-full text-left text-sm">
        <caption className="sr-only">Materialbedarf für die offene Menge</caption>
        <thead className="text-muted"><tr><th scope="col" className="py-2">Komponente</th><th scope="col" className="text-right">Bedarf (offen)</th><th scope="col" className="text-right">Bestand</th><th scope="col" className="text-right">Fehlmenge</th></tr></thead>
        <tbody className="divide-y divide-line">
          {o.requirements.map((r) => <tr key={r.componentItemId}><td className="py-1.5">{r.item.number} {r.item.name}</td><td className="text-right">{r.needed.toString()} {r.item.unit}</td><td className="text-right">{r.onHand.toString()}</td><td className="text-right">{r.short.gt(0) ? r.short.toString() : "–"}</td></tr>)}
        </tbody>
      </table>

      {confirmer && o.status === "RELEASED" && (
        <form action={confirm} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Rückmeldung">
          <input type="hidden" name="id" value={o.id} />
          <h2 className="font-medium">Rückmeldung</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label>Menge<input name="quantity" required inputMode="decimal" className={input} /></label>
            <label>Komponenten entnehmen aus<select name="componentLocationId" className={input}><option value="">Ohne Lagerort</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code} {l.name}</option>)}</select></label>
            <label>Endprodukt einlagern in<select name="outputLocationId" className={input}><option value="">Ohne Lagerort</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code} {l.name}</option>)}</select></label>
            {tracked === "BATCH" && <label>Charge<input name="batchNumber" required maxLength={40} className={input} /></label>}
            {tracked === "BATCH" && <label>Ablaufdatum<input type="date" name="expiresOn" className={input} /></label>}
            {tracked === "SERIAL" && <label className="sm:col-span-2">Seriennummern<textarea name="serials" required rows={2} className={input} /></label>}
          </div>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Zurückmelden</button>
        </form>
      )}

      <section aria-label="Rückmeldungen" className="space-y-2">
        <h2 className="font-medium">Rückmeldungen</h2>
        {o.confirmations.length === 0 ? <p className="text-sm text-muted">Noch keine Rückmeldungen.</p> : (
          <ul className="divide-y divide-line text-sm">
            {o.confirmations.map((c) => (
              <li key={c.id} className="flex flex-wrap items-end justify-between gap-3 py-2">
                <span>{c.createdAt.toISOString().slice(0, 16).replace("T", " ")} · {c.quantity.toString()} {o.item.unit}{c.batchNumber ? ` · Charge ${c.batchNumber}` : ""}{c.reversedAt ? ` · zurückgenommen (${c.reverseReason})` : ""}</span>
                {confirmer && !c.reversedAt && (
                  <form action={reverse} className="flex items-end gap-2"><input type="hidden" name="id" value={o.id} /><input type="hidden" name="confirmationId" value={c.id} />
                    <label>Grund<input name="reason" required minLength={3} className="mt-1 block rounded-md border border-line bg-bg px-2 py-0.5" /></label>
                    <button className="rounded-md border border-line px-2 py-0.5">Zurücknehmen</button></form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
