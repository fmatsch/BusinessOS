import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createProductionOrder, listBoms, listProductionOrders } from "@/modules/production/service";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/production";
const STATUS: Record<string, string> = { DRAFT: "Entwurf", RELEASED: "freigegeben", COMPLETED: "fertig", CANCELLED: "storniert" };

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const o = await runAction(BACK, () => createProductionOrder(ctx, { itemId: fd.get("itemId"), quantity: String(fd.get("quantity") ?? "").replace(",", "."), plannedDate: fd.get("plannedDate"), note: fd.get("note") }));
  redirect(`/production/${o.id}`);
}

export default async function ProductionPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let orders, boms;
  try { [orders, boms] = await Promise.all([listProductionOrders(ctx), listBoms(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "production.order.manage");
  const makeable = boms.filter((b) => b.status === "ACTIVE");
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fertigung</h1>
        <p className="text-sm text-muted">Stücklisten, Fertigungsaufträge mit Rückmeldung (Komponentenverbrauch und Zugang des Endprodukts im Lager, Einstandspreis aus den Komponenten) und Bedarfsplanung. Nicht enthalten: Arbeitsgänge/Kapazitäten, Fertigungszeiten, Kuppelprodukte, Qualitätsprüfung in der Rückmeldung.</p>
      </div>
      <ErrorBanner message={error} />
      <p className="flex flex-wrap gap-4 text-sm">
        <Link className="text-accent underline" href="/production/boms">Stücklisten</Link>
        <Link className="text-accent underline" href="/production/mrp">Bedarfsplanung</Link>
      </p>
      {manage && (
        <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4" aria-label="Fertigungsauftrag anlegen">
          <h2 className="font-medium sm:col-span-4">Fertigungsauftrag anlegen</h2>
          <label className="sm:col-span-2">Artikel (mit aktiver Stückliste)<select name="itemId" required className={input}><option value="">–</option>{makeable.map((b) => <option key={b.id} value={b.itemId}>{b.item.number} {b.item.name}</option>)}</select></label>
          <label>Menge<input name="quantity" required inputMode="decimal" className={input} /></label>
          <label>Geplant am<input type="date" name="plannedDate" className={input} /></label>
          <div className="sm:col-span-4"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button></div>
        </form>
      )}
      {orders.length === 0 ? <p className="text-sm text-muted">Noch keine Fertigungsaufträge.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Fertigungsaufträge</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Nummer</th><th scope="col">Artikel</th><th scope="col" className="text-right">Menge</th><th scope="col" className="text-right">Gefertigt</th><th scope="col">Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {orders.map((o) => (
              <tr key={o.id}><td className="py-1.5"><Link className="text-accent underline" href={`/production/${o.id}`}>{o.number ?? "Entwurf"}</Link></td><td>{o.item.number} {o.item.name}</td><td className="text-right">{o.quantity.toString()}</td><td className="text-right">{o.produced.toString()}</td><td>{STATUS[o.status]}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
