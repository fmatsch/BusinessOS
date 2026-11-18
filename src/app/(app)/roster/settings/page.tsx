import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { listEmployees } from "@/modules/hr/service";
import {
  createQualification, createSite, createTemplate, getRules, listQualifications, listSites, listTemplates, setEmployeeQualification, setRules,
} from "@/modules/roster/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/roster/settings";

async function site(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createSite(ctx, { name: formData.get("name"), timeZone: formData.get("timeZone") }));
  revalidatePath(BACK);
}
async function qualification(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createQualification(ctx, { name: formData.get("name") }));
  revalidatePath(BACK);
}
async function grant(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => setEmployeeQualification(ctx, String(formData.get("employeeId")), String(formData.get("qualificationId")), formData.get("on") === "yes"));
  revalidatePath(BACK);
}
async function template(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createTemplate(ctx, {
    name: formData.get("name"), startTime: formData.get("startTime"), endTime: formData.get("endTime"), breakMinutes: formData.get("breakMinutes"),
    requiredCount: formData.get("requiredCount"), qualificationId: formData.get("qualificationId") || null,
  }));
  revalidatePath(BACK);
}
async function rules(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const h = (k: string) => Math.round(Number(String(formData.get(k) ?? "").replace(",", ".")) * 60);
  await runAction(BACK, () => setRules(ctx, {
    restDailyMinutes: h("restDaily"), maxDailyMinutes: h("maxDaily"), maxWeeklyMinutes: h("maxWeekly"),
    breakAfterMinutes: h("breakAfter"), minBreakMinutes: formData.get("minBreak"), weeklyRestMinutes: h("weeklyRest"),
  }));
  revalidatePath(BACK);
}

export default async function RosterSettings({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "roster.plan") && !can(ctx, "roster.read_all")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const planner = can(ctx, "roster.plan");
  const [sites, quals, templates, r, employees] = await Promise.all([
    listSites(ctx), listQualifications(ctx), listTemplates(ctx), getRules(ctx), planner && can(ctx, "hr.employee.read") ? listEmployees(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const hours = (m: number) => String(m / 60);

  return (
    <div className="max-w-4xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dienstplan: Einstellungen</h1>
      <ErrorBanner message={error} />

      <section className="space-y-2">
        <h2 className="font-medium">Standorte</h2>
        {planner && (
          <form action={site} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
            <label>Name<input name="name" required maxLength={80} className={input} /></label>
            <label>Zeitzone<input name="timeZone" required defaultValue={ctx.timeZone} className={input} /></label>
            <button className={primary}>Anlegen</button>
          </form>
        )}
        {sites.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : <ul className="text-sm">{sites.map((s) => <li key={s.id}>{s.name} · {s.timeZone}</li>)}</ul>}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Qualifikationen</h2>
        {planner && (
          <form action={qualification} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
            <label>Name<input name="name" required maxLength={80} className={input} /></label><button className={primary}>Anlegen</button>
          </form>
        )}
        {quals.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
          <ul className="space-y-2 text-sm">
            {quals.map((q) => (
              <li key={q.id} className="rounded-xl border border-line bg-surface p-3">
                <p><strong>{q.name}</strong> · {q.employees.length} Personen</p>
                {planner && employees.length > 0 && (
                  <form action={grant} className="mt-2 flex flex-wrap items-center gap-2">
                    <input type="hidden" name="qualificationId" value={q.id} />
                    <select name="employeeId" required aria-label={`Person für Qualifikation ${q.name}`} className="rounded-md border border-line bg-bg px-2 py-1">
                      <option value="">Person …</option>
                      {employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.lastName} {e.firstName}{q.employees.some((x) => x.employeeId === e.id) ? " ✓" : ""}</option>)}
                    </select>
                    <button name="on" value="yes" className="rounded-md border border-line px-2 py-1">Erteilen</button>
                    <button name="on" value="no" className="rounded-md border border-line px-2 py-1">Entziehen</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Schichtvorlagen</h2>
        {planner && (
          <form action={template} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
            <label className="sm:col-span-2">Name<input name="name" required maxLength={80} className={input + " w-full"} /></label>
            <label>Beginn<input type="time" name="startTime" required className={input} /></label>
            <label>Ende<input type="time" name="endTime" required className={input} /></label>
            <label>Pause (min)<input name="breakMinutes" type="number" min={0} defaultValue={30} className={input} /></label>
            <label>Personen<input name="requiredCount" type="number" min={1} defaultValue={1} className={input} /></label>
            <label className="sm:col-span-2">Qualifikation<select name="qualificationId" className={input}><option value="">–</option>{quals.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select></label>
            <div className="sm:col-span-4 self-end"><button className={primary}>Vorlage anlegen</button></div>
          </form>
        )}
        {templates.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : <ul className="text-sm">{templates.map((t) => <li key={t.id}>{t.name} · {t.startTime}–{t.endTime} · Pause {t.breakMinutes} min · {t.requiredCount} Personen</li>)}</ul>}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Arbeitszeitregeln</h2>
        <p className="text-sm text-muted">Voreinstellung nach österreichischem Arbeitszeitgesetz; abweichende Regeln (Kollektivvertrag, Betriebsvereinbarung) können hier hinterlegt werden. Keine Rechtsberatung.</p>
        <form action={rules} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3">
          <label>Tagesruhezeit (Std.)<input name="restDaily" defaultValue={hours(r.restDailyMinutes)} disabled={!can(ctx, "roster.rules.manage")} className={input} /></label>
          <label>Höchstarbeitszeit je Tag (Std.)<input name="maxDaily" defaultValue={hours(r.maxDailyMinutes)} disabled={!can(ctx, "roster.rules.manage")} className={input} /></label>
          <label>Höchstarbeitszeit je Woche (Std.)<input name="maxWeekly" defaultValue={hours(r.maxWeeklyMinutes)} disabled={!can(ctx, "roster.rules.manage")} className={input} /></label>
          <label>Pause ab Schichtlänge (Std.)<input name="breakAfter" defaultValue={hours(r.breakAfterMinutes)} disabled={!can(ctx, "roster.rules.manage")} className={input} /></label>
          <label>Mindestpause (min)<input name="minBreak" type="number" defaultValue={r.minBreakMinutes} disabled={!can(ctx, "roster.rules.manage")} className={input} /></label>
          <label>Wochenruhe (Std.)<input name="weeklyRest" defaultValue={hours(r.weeklyRestMinutes)} disabled={!can(ctx, "roster.rules.manage")} className={input} /></label>
          {can(ctx, "roster.rules.manage") && <div className="sm:col-span-3"><button className={primary}>Regeln speichern</button></div>}
        </form>
      </section>
    </div>
  );
}
