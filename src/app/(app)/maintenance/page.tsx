import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { generateDueOrders, listMaintenanceObjects, listMaintenanceOrders, reportIssue } from "@/modules/maintenance/service";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/maintenance";
const STATUS: Record<string, string> = { OPEN: "offen", IN_PROGRESS: "in Arbeit", DONE: "erledigt", CANCELLED: "storniert" };
const PRIO: Record<string, string> = { LOW: "niedrig", NORMAL: "normal", HIGH: "hoch", URGENT: "dringend" };

async function report(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => reportIssue(ctx, { objectId: fd.get("objectId"), title: fd.get("title"), description: fd.get("description"), priority: fd.get("priority") })); revalidatePath(BACK); }
async function generate() { "use server"; const ctx = await requireContext(); await runAction(BACK, () => generateDueOrders(ctx)); revalidatePath(BACK); }

export default async function MaintenancePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "maint.read") && !can(ctx, "maint.report")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  let objects, orders = null;
  try {
    objects = (await listMaintenanceObjects(ctx)).filter((o) => o.active);
    if (can(ctx, "maint.read")) orders = await listMaintenanceOrders(ctx);
  } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Instandhaltung</h1>
        <p className="text-sm text-muted">Technische Objekte, Wartungspläne (Tage/Monate) mit automatisch erzeugten Aufträgen, Störungsmeldungen, Abschluss mit Bericht, Zeitaufwand und Ersatzteilen aus dem Lager. Nicht enthalten: Zählerstands-Intervalle, Ausfallzeiten/Kennzahlen, Arbeitsgenehmigungen, Fremdleistungen, Kosten.</p>
      </div>
      <ErrorBanner message={error} />
      {can(ctx, "maint.read") && <p className="flex flex-wrap gap-4 text-sm"><Link className="text-accent underline" href="/maintenance/plans">Objekte und Wartungspläne</Link></p>}
      {can(ctx, "maint.report") && (
        <form action={report} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4" aria-label="Störung melden">
          <h2 className="font-medium sm:col-span-4">Störung melden</h2>
          <label>Objekt<select name="objectId" required className={input}><option value="">–</option>{objects.map((o) => <option key={o.id} value={o.id}>{o.number} {o.name}</option>)}</select></label>
          <label className="sm:col-span-2">Was ist passiert?<input name="title" required minLength={3} maxLength={120} className={input} /></label>
          <label>Priorität<select name="priority" defaultValue="NORMAL" className={input}>{Object.entries(PRIO).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="sm:col-span-4">Beschreibung<input name="description" maxLength={2000} className={input} /></label>
          <div className="sm:col-span-4"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Melden</button></div>
        </form>
      )}
      {orders && (
        <section aria-label="Aufträge" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Aufträge</h2>
            {can(ctx, "maint.manage") && <form action={generate}><button className="rounded-md border border-line px-3 py-1.5 text-sm">Fällige Wartungen erzeugen</button></form>}
          </div>
          {orders.length === 0 ? <p className="text-sm text-muted">Keine Aufträge.</p> : (
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Instandhaltungsaufträge</caption>
              <thead className="text-muted"><tr><th scope="col" className="py-2">Nummer</th><th scope="col">Objekt</th><th scope="col">Titel</th><th scope="col">Art</th><th scope="col">Priorität</th><th scope="col">Fällig</th><th scope="col">Status</th></tr></thead>
              <tbody className="divide-y divide-line">
                {orders.map((o) => (
                  <tr key={o.id}><td className="py-1.5"><Link className="text-accent underline" href={`/maintenance/${o.id}`}>{o.number}</Link></td><td>{o.object.number} {o.object.name}</td><td>{o.title}</td><td>{o.kind === "PREVENTIVE" ? "vorbeugend" : "Störung"}</td><td>{PRIO[o.priority]}</td><td>{o.dueOn ? o.dueOn.toISOString().slice(0, 10) : "–"}</td><td>{STATUS[o.status]}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
