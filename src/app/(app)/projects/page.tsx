import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { listCostCenters } from "@/modules/masterdata/service";
import { listCrmCustomers } from "@/modules/crm/service";
import { bookProjectTime, createProject, listProjects } from "@/modules/projects/service";
import { minutesToHours } from "@/modules/projects/rules";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/projects";

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createProject(ctx, { name: fd.get("name"), customerId: fd.get("customerId"), costCenterId: fd.get("costCenterId"), hourlyRate: fd.get("hourlyRate"), budgetHours: fd.get("budgetHours"), startsOn: fd.get("startsOn"), endsOn: fd.get("endsOn"), note: fd.get("note") }));
  revalidatePath(BACK);
}
async function book(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => bookProjectTime(ctx, { projectId: fd.get("projectId"), workDate: fd.get("workDate"), hours: String(fd.get("hours") ?? "").replace(",", "."), note: fd.get("note") }));
  revalidatePath(BACK);
}

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let projects;
  try { projects = await listProjects(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "project.manage"), booker = can(ctx, "project.time.book");
  const [customers, costCenters] = await Promise.all([
    manage && can(ctx, "crm.read") ? listCrmCustomers(ctx) : Promise.resolve([]),
    manage && can(ctx, "master.costcenter.read") ? listCostCenters(ctx) : Promise.resolve([]),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const active = projects.filter((p) => p.status === "ACTIVE");
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Projekte</h1>
        <p className="text-sm text-muted">Leistungserfassung und Abrechnung nach Stunden. Projektstunden sind eine <strong>eigene Erfassung</strong> neben der Arbeitszeit und werden nicht damit abgeglichen. Abgerechnet wird als Rechnungsentwurf in den Finanzen.</p>
      </div>
      <ErrorBanner message={error} />

      {booker && active.length > 0 && (
        <form action={book} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
          <h2 className="font-medium sm:col-span-6">Zeit buchen</h2>
          <label className="sm:col-span-2">Projekt<select name="projectId" required className={input}>{active.map((p) => <option key={p.id} value={p.id}>{p.number} {p.name}</option>)}</select></label>
          <label>Datum<input type="date" name="workDate" defaultValue={today} max={today} required className={input} /></label>
          <label>Stunden<input name="hours" required inputMode="decimal" placeholder="z. B. 1,5" className={input} /></label>
          <label>Notiz<input name="note" maxLength={200} className={input} /></label>
          <div className="flex items-end"><button className={primary}>Buchen</button></div>
        </form>
      )}

      {manage && (
        <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
          <h2 className="font-medium sm:col-span-6">Projekt anlegen</h2>
          <label className="sm:col-span-2">Name<input name="name" required maxLength={120} className={input} /></label>
          <label className="sm:col-span-2">Kunde<select name="customerId" className={input}><option value="">–</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.number} {c.name}</option>)}</select></label>
          <label className="sm:col-span-2">Kostenstelle<select name="costCenterId" className={input}><option value="">–</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></label>
          <label>Stundensatz (netto)<input name="hourlyRate" inputMode="decimal" className={input} /></label>
          <label>Stundenbudget<input name="budgetHours" inputMode="decimal" className={input} /></label>
          <label>Beginn<input type="date" name="startsOn" className={input} /></label>
          <label>Ende<input type="date" name="endsOn" className={input} /></label>
          <label className="sm:col-span-2">Hinweis<input name="note" maxLength={300} className={input} /></label>
          <div className="sm:col-span-6"><button className={primary}>Projekt anlegen</button></div>
        </form>
      )}

      {projects.length === 0 ? <p className="text-sm text-muted">Noch keine Projekte.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Nummer</th><th>Projekt</th><th className="text-right">Gebucht (h)</th><th className="text-right">Budget</th><th className="text-right">Offen abzurechnen (h)</th><th className="text-right">Satz</th><th>Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {projects.map((p) => (
              <tr key={p.id}>
                <td className="py-2"><Link className="text-accent underline" href={`/projects/${p.id}`}>{p.number}</Link></td><td>{p.name}</td>
                <td className="text-right">{minutesToHours(p.bookedMinutes).toString()}</td>
                <td className="text-right">{p.budgetUsed === null ? "–" : `${p.budgetUsed} % von ${p.budgetHours?.toString()} h`}</td>
                <td className="text-right">{minutesToHours(p.bookedMinutes - p.billedMinutes).toString()}</td>
                <td className="text-right">{p.hourlyRate ? formatMoney(p.hourlyRate.toString()) : "–"}</td>
                <td>{p.status === "ACTIVE" ? "aktiv" : "abgeschlossen"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
