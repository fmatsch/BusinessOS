import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { listItems, listStockableReceiptLines, stockReceiptLine } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/inventory/receipts";

async function stock(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => stockReceiptLine(ctx, { goodsReceiptLineId: fd.get("lineId"), itemId: fd.get("itemId") }));
  revalidatePath(BACK);
}

export default async function ReceiptsToStock({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let lines, items;
  try { [lines, items] = await Promise.all([listStockableReceiptLines(ctx), listItems(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const active = items.filter((i) => i.active);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/inventory">← Lager</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Wareneingänge einbuchen</h1>
        <p className="text-sm text-muted">Positionen aus der Beschaffung, die noch nicht im Lager stehen (die letzten 300). Jede Position wird höchstens einmal eingebucht. Gegenbuchungen (negative Menge) nehmen automatisch den Artikel der ursprünglichen Position.</p>
      </div>
      <ErrorBanner message={error} />
      {lines.length === 0 ? <p className="text-sm text-muted">Nichts einzubuchen.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Datum</th><th>Bestellung</th><th>Position</th><th className="text-right">Menge</th><th>Artikel</th></tr></thead>
          <tbody className="divide-y divide-line">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="py-2">{l.receivedOn.toISOString().slice(0, 10)}</td><td>{l.orderNumber}</td><td>{l.description}{l.quantity.lt(0) ? " (Gegenbuchung)" : ""}</td><td className="text-right">{l.quantity.toString()}</td>
                <td>
                  <form action={stock} className="flex items-center gap-2"><input type="hidden" name="lineId" value={l.id} />
                    {l.quantity.lt(0) ? <span className="text-muted">Artikel der ursprünglichen Position</span> : (
                      <select name="itemId" required aria-label="Artikel wählen" className="rounded-md border border-line bg-bg px-2 py-0.5"><option value="">Artikel wählen …</option>{active.map((i) => <option key={i.id} value={i.id}>{i.number} {i.name}</option>)}</select>
                    )}
                    <button className="rounded-md border border-line px-2 py-0.5">Einbuchen</button></form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
