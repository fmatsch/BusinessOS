import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { cancelMaintenanceOrder, completeMaintenanceOrder, getMaintenanceOrder, startMaintenanceOrder } from "@/modules/maintenance/service";
import { listItems, listLocations } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const here = (id: string) => `/maintenance/${id}`;
const STATUS: Record<string, string> = { OPEN: "offen", IN_PROGRESS: "in Arbeit", DONE: "erledigt", CANCELLED: "storniert" };
const PARTS = 3;

async function start(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => startMaintenanceOrder(ctx, id)); revalidatePath(here(id)); }
async function cancel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => cancelMaintenanceOrder(ctx, id)); revalidatePath(here(id)); }
async function complete(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  const parts = Array.from({ length: PARTS }, (_, i) => ({ itemId: String(fd.get(`item${i}`) ?? ""), quantity: String(fd.get(`qty${i}`) ?? "").replace(",", "."), locationId: fd.get(`loc${i}`) })).filter((p) => p.itemId !== "");
  await runAction(here(id), () => completeMaintenanceOrder(ctx, id, { report: fd.get("report"), minutesSpent: fd.get("minutesSpent"), doneOn: fd.get("doneOn"), parts }));
  revalidatePath(here(id));
}

export default async function MaintenanceOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let o;
  try { o = await getMaintenanceOrder(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const worker = can(ctx, "maint.work") && (o.status === "OPEN" || o.status === "IN_PROGRESS"), manager = can(ctx, "maint.manage") && (o.status === "OPEN" || o.status === "IN_PROGRESS");
  const items = worker && can(ctx, "inventory.read") ? (await listItems(ctx)).filter((i) => i.active) : [];
  const locations = worker && can(ctx, "inventory.read") ? (await listLocations(ctx)).filter((l) => l.active) : [];
  const today = new Date().toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/maintenance">← Instandhaltung</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">{o.number} · {o.title} · {STATUS[o.status]}</h1>
        <p className="text-sm text-muted">{o.object.number} {o.object.name}{o.object.location ? ` (${o.object.location})` : ""} · {o.kind === "PREVENTIVE" ? "vorbeugend" : "Störung"} · Priorität {o.priority}{o.dueOn ? ` · fällig ${o.dueOn.toISOString().slice(0, 10)}` : ""}</p>
        {o.description && <p className="text-sm">{o.description}</p>}
      </div>
      <ErrorBanner message={error} />
      <div className="flex gap-3 text-sm">
        {worker && o.status === "OPEN" && <form action={start}><input type="hidden" name="id" value={o.id} /><button className="rounded-md border border-line px-3 py-1.5">Beginnen</button></form>}
        {manager && <form action={cancel}><input type="hidden" name="id" value={o.id} /><button className="rounded-md border border-line px-3 py-1.5">Stornieren</button></form>}
      </div>
      {worker && (
        <form action={complete} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Abschluss">
          <input type="hidden" name="id" value={o.id} />
          <h2 className="font-medium">Abschluss</h2>
          <label className="block">Bericht<input name="report" required minLength={3} maxLength={2000} className={input} /></label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>Zeitaufwand (Minuten)<input name="minutesSpent" type="number" min={0} defaultValue={0} required className={input} /></label>
            <label>Erledigt am<input name="doneOn" type="date" defaultValue={today} max={today} required className={input} /></label>
          </div>
          {Array.from({ length: PARTS }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-4">
              <label className="sm:col-span-2">Ersatzteil {i + 1}<select name={`item${i}`} className={input}><option value="">–</option>{items.map((x) => <option key={x.id} value={x.id}>{x.number} {x.name}</option>)}</select></label>
              <label>Menge {i + 1}<input name={`qty${i}`} inputMode="decimal" className={input} /></label>
              <label>Lagerort {i + 1}<select name={`loc${i}`} className={input}><option value="">Ohne Lagerort</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.code} {l.name}</option>)}</select></label>
            </div>
          ))}
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Abschließen</button>
        </form>
      )}
      {o.status === "DONE" && (
        <section aria-label="Bericht" className="space-y-1 text-sm">
          <h2 className="font-medium">Bericht</h2>
          <p>{o.report}</p>
          <p className="text-muted">{o.minutesSpent} Minuten · erledigt am {o.doneOn?.toISOString().slice(0, 10)}</p>
          {o.parts.length > 0 && <p>Ersatzteile: {o.parts.map((p) => `${p.item.number} ${p.item.name} × ${p.quantity.toString()}`).join(", ")}</p>}
        </section>
      )}
    </div>
  );
}
