import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createMaintenanceObject, createMaintenancePlan, listMaintenanceObjects, listMaintenancePlans, setMaintenanceObjectActive, setMaintenancePlanActive } from "@/modules/maintenance/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/maintenance/plans";

async function addObject(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createMaintenanceObject(ctx, { name: fd.get("name"), location: fd.get("location") })); revalidatePath(BACK); }
async function toggleObject(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setMaintenanceObjectActive(ctx, String(fd.get("id")), fd.get("active") === "1")); revalidatePath(BACK); }
async function addPlan(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createMaintenancePlan(ctx, { objectId: fd.get("objectId"), title: fd.get("title"), instructions: fd.get("instructions"), intervalUnit: fd.get("intervalUnit"), intervalValue: fd.get("intervalValue"), firstDueOn: fd.get("firstDueOn") })); revalidatePath(BACK); }
async function togglePlan(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setMaintenancePlanActive(ctx, String(fd.get("id")), fd.get("active") === "1")); revalidatePath(BACK); }

export default async function MaintenancePlansPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let objects, plans;
  try { [objects, plans] = await Promise.all([listMaintenanceObjects(ctx), listMaintenancePlans(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "maint.manage");
  const today = new Date().toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/maintenance">← Instandhaltung</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Objekte und Wartungspläne</h1>
      </div>
      <ErrorBanner message={error} />
      <section className="space-y-3" aria-label="Objekte">
        <h2 className="font-medium">Technische Objekte</h2>
        {manage && (
          <form action={addObject} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3" aria-label="Objekt anlegen">
            <label>Name<input name="name" required maxLength={120} className={input} /></label>
            <label>Standort<input name="location" maxLength={120} className={input} /></label>
            <div className="self-end"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Objekt anlegen</button></div>
          </form>
        )}
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Objekte</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Nummer</th><th scope="col">Name</th><th scope="col">Standort</th><th scope="col">Status</th>{manage && <th />}</tr></thead>
          <tbody className="divide-y divide-line">
            {objects.map((o) => (
              <tr key={o.id}><td className="py-1.5">{o.number}</td><td>{o.name}</td><td>{o.location ?? ""}</td><td>{o.active ? "aktiv" : "inaktiv"}</td>
                {manage && <td><form action={toggleObject}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="active" value={o.active ? "0" : "1"} /><button className="rounded-md border border-line px-2 py-0.5">{o.active ? "Deaktivieren" : "Aktivieren"}</button></form></td>}</tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="space-y-3" aria-label="Wartungspläne">
        <h2 className="font-medium">Wartungspläne</h2>
        {manage && (
          <form action={addPlan} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4" aria-label="Wartungsplan anlegen">
            <label>Objekt<select name="objectId" required className={input}><option value="">–</option>{objects.filter((o) => o.active).map((o) => <option key={o.id} value={o.id}>{o.number} {o.name}</option>)}</select></label>
            <label className="sm:col-span-2">Titel<input name="title" required maxLength={120} className={input} /></label>
            <label>Erste Fälligkeit<input type="date" name="firstDueOn" defaultValue={today} required className={input} /></label>
            <label>Intervall<input type="number" name="intervalValue" min={1} defaultValue={3} required className={input} /></label>
            <label>Einheit<select name="intervalUnit" className={input}><option value="MONTHS">Monate</option><option value="DAYS">Tage</option></select></label>
            <label className="sm:col-span-2">Anweisung<input name="instructions" maxLength={2000} className={input} /></label>
            <div className="sm:col-span-4"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Plan anlegen</button></div>
          </form>
        )}
        {plans.length === 0 ? <p className="text-sm text-muted">Noch keine Wartungspläne.</p> : (
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Wartungspläne</caption>
            <thead className="text-muted"><tr><th scope="col" className="py-2">Objekt</th><th scope="col">Titel</th><th scope="col">Intervall</th><th scope="col">Nächste Fälligkeit</th><th scope="col">Zuletzt</th><th scope="col">Status</th>{manage && <th />}</tr></thead>
            <tbody className="divide-y divide-line">
              {plans.map((p) => (
                <tr key={p.id}><td className="py-1.5">{p.object.number} {p.object.name}</td><td>{p.title}</td><td>{p.intervalValue} {p.intervalUnit === "DAYS" ? "Tage" : "Monate"}</td>
                  <td>{p.nextDueOn.toISOString().slice(0, 10)}{p.daysUntilDue < 0 ? ` (${-p.daysUntilDue} Tage überfällig)` : ""}</td><td>{p.lastDoneOn ? p.lastDoneOn.toISOString().slice(0, 10) : "–"}</td><td>{p.active ? "aktiv" : "inaktiv"}</td>
                  {manage && <td><form action={togglePlan}><input type="hidden" name="id" value={p.id} /><input type="hidden" name="active" value={p.active ? "0" : "1"} /><button className="rounded-md border border-line px-2 py-0.5">{p.active ? "Deaktivieren" : "Aktivieren"}</button></form></td>}</tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
