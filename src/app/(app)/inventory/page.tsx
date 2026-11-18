import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createItem, listItems } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/inventory";

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createItem(ctx, { number: fd.get("number"), name: fd.get("name"), unit: fd.get("unit") || "Stk", reorderLevel: String(fd.get("reorderLevel") ?? "").replace(",", ".") }));
  revalidatePath(BACK);
}

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let items;
  try { items = await listItems(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const below = items.filter((i) => i.belowReorder).length;

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lager</h1>
        <p className="text-sm text-muted">Artikel und Bestände aus einem Journal: Wareneingänge aus der Beschaffung einbuchen, Entnahmen und Inventurkorrekturen buchen. Ein Lager je Organisation, ohne Lagerorte, Chargen und Bewertung.</p>
      </div>
      <ErrorBanner message={error} />
      {below > 0 && <p role="status" className="text-sm font-medium">{below} Artikel am oder unter dem Mindestbestand.</p>}
      {can(ctx, "inventory.move") && <p className="text-sm"><Link className="text-accent underline" href="/inventory/receipts">Wareneingänge einbuchen</Link></p>}
      {can(ctx, "inventory.manage") && (
        <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-5">
          <h2 className="font-medium sm:col-span-5">Artikel anlegen</h2>
          <label>Artikelnummer<input name="number" required maxLength={30} className={input} /></label>
          <label className="sm:col-span-2">Bezeichnung<input name="name" required maxLength={120} className={input} /></label>
          <label>Einheit<input name="unit" defaultValue="Stk" maxLength={10} className={input} /></label>
          <label>Mindestbestand<input name="reorderLevel" inputMode="decimal" className={input} /></label>
          <div className="sm:col-span-5"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button></div>
        </form>
      )}
      {items.length === 0 ? <p className="text-sm text-muted">Noch keine Artikel.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Nummer</th><th>Bezeichnung</th><th className="text-right">Bestand</th><th>Einheit</th><th className="text-right">Mindestbestand</th><th>Hinweis</th></tr></thead>
          <tbody className="divide-y divide-line">
            {items.map((i) => (
              <tr key={i.id} className={i.active ? "" : "text-muted"}>
                <td className="py-2"><Link className="text-accent underline" href={`/inventory/${i.id}`}>{i.number}</Link></td><td>{i.name}{i.active ? "" : " (inaktiv)"}</td>
                <td className="text-right">{i.onHand.toString()}</td><td>{i.unit}</td><td className="text-right">{i.reorderLevel?.toString() ?? "–"}</td>
                <td>{i.belowReorder ? "nachbestellen" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
