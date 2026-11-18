import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { listCostCenters } from "@/modules/masterdata/service";
import { adjustStock, getItem, issueStock, reverseMovement } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const here = (id: string) => `/inventory/${id}`;
const KIND: Record<string, string> = { RECEIPT: "Wareneingang", ISSUE: "Entnahme", ADJUST: "Inventurkorrektur", REVERSAL: "Gegenbuchung" };
const num = (v: FormDataEntryValue | null) => String(v ?? "").replace(",", ".");

async function issue(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("itemId"));
  await runAction(here(id), () => issueStock(ctx, { itemId: id, quantity: num(fd.get("quantity")), costCenterId: fd.get("costCenterId"), note: fd.get("note") }));
  revalidatePath(here(id));
}
async function adjust(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("itemId"));
  await runAction(here(id), () => adjustStock(ctx, { itemId: id, counted: num(fd.get("counted")), reason: fd.get("reason") }));
  revalidatePath(here(id));
}
async function reverse(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("itemId"));
  await runAction(here(id), () => reverseMovement(ctx, String(fd.get("movementId")), String(fd.get("reason") ?? "")));
  revalidatePath(here(id));
}

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let item;
  try { item = await getItem(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const mover = can(ctx, "inventory.move");
  const costCenters = mover && can(ctx, "master.costcenter.read") ? await listCostCenters(ctx) : [];
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/inventory">← Lager</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">{item.number} · {item.name}</h1>
        <p className="text-sm text-muted">Bestand <strong>{item.onHand.toString()} {item.unit}</strong>{item.reorderLevel ? ` · Mindestbestand ${item.reorderLevel.toString()}` : ""}{item.active ? "" : " · inaktiv"}</p>
      </div>
      <ErrorBanner message={error} />
      {mover && item.active && (
        <div className="grid gap-4 sm:grid-cols-2">
          <form action={issue} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
            <input type="hidden" name="itemId" value={item.id} />
            <h2 className="font-medium">Entnahme</h2>
            <label>Menge<input name="quantity" required inputMode="decimal" className={input + " w-full"} /></label>
            <label>Kostenstelle<select name="costCenterId" className={input + " w-full"}><option value="">–</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></label>
            <label>Notiz<input name="note" maxLength={200} className={input + " w-full"} /></label>
            <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Entnehmen</button>
          </form>
          <form action={adjust} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
            <input type="hidden" name="itemId" value={item.id} />
            <h2 className="font-medium">Inventur</h2>
            <label>Gezählter Bestand<input name="counted" required inputMode="decimal" className={input + " w-full"} /></label>
            <label>Grund<input name="reason" required minLength={3} maxLength={200} className={input + " w-full"} /></label>
            <button className="rounded-md border border-line px-3 py-1.5">Korrektur buchen</button>
          </form>
        </div>
      )}
      <section aria-label="Bewegungen" className="space-y-2">
        <h2 className="font-medium">Bewegungen</h2>
        {item.movements.length === 0 ? <p className="text-sm text-muted">Noch keine Bewegungen.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Zeit</th><th>Art</th><th className="text-right">Menge</th><th>Notiz</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {item.movements.map((m) => (
                <tr key={m.id}>
                  <td className="py-2">{m.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{KIND[m.kind]}{m.reversed ? " (korrigiert)" : ""}</td>
                  <td className="text-right">{m.quantity.toString()}</td><td>{m.note ?? ""}</td>
                  <td>
                    {mover && (m.kind === "ISSUE" || m.kind === "ADJUST") && !m.reversed && (
                      <form action={reverse} className="flex items-center gap-1"><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="movementId" value={m.id} />
                        <input name="reason" required minLength={3} placeholder="Grund" aria-label="Grund der Korrektur" className="w-28 rounded-md border border-line bg-bg px-2 py-0.5" />
                        <button className="rounded-md border border-line px-2 py-0.5">Korrigieren</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted">Das Journal ist unveränderlich. Einbuchungen aus dem Wareneingang werden in der Beschaffung korrigiert und danach unter „Wareneingänge einbuchen“ nachgezogen.</p>
      </section>
    </div>
  );
}
