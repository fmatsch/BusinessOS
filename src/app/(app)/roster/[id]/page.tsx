import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { runOutbox } from "@/modules/events";
import { listEmployees } from "@/modules/hr/service";
import { addShift, assignEmployee, getRoster, listQualifications, listTemplates, publishRoster, removeShift, unassignEmployee } from "@/modules/roster/service";
import { localParts } from "@/modules/roster/timezone";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";

async function add(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("rosterId"));
  await runAction(`/roster/${id}`, () => addShift(ctx, {
    rosterId: id, date: formData.get("date"), startTime: formData.get("startTime"), endTime: formData.get("endTime"),
    breakMinutes: formData.get("breakMinutes"), requiredCount: formData.get("requiredCount"), qualificationId: formData.get("qualificationId") || null, label: formData.get("label"),
  }));
  revalidatePath(`/roster/${id}`);
}
async function remove(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("rosterId"));
  await runAction(`/roster/${id}`, () => removeShift(ctx, String(formData.get("shiftId"))));
  revalidatePath(`/roster/${id}`);
}
async function assign(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("rosterId"));
  await runAction(`/roster/${id}`, () => assignEmployee(ctx, { shiftId: formData.get("shiftId"), employeeId: formData.get("employeeId") }));
  revalidatePath(`/roster/${id}`);
}
async function unassign(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("rosterId"));
  await runAction(`/roster/${id}`, () => unassignEmployee(ctx, String(formData.get("shiftId")), String(formData.get("employeeId"))));
  revalidatePath(`/roster/${id}`);
}
async function publish(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("rosterId"));
  await runAction(`/roster/${id}`, () => publishRoster(ctx, id, String(formData.get("reason") ?? "")));
  after(() => runOutbox());
  revalidatePath(`/roster/${id}`);
}

export default async function RosterDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let data;
  try { data = await getRoster(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const { roster, people, check } = data;
  const planner = can(ctx, "roster.plan");
  const tz = roster.site.timeZone;
  const [employees, quals, templates] = await Promise.all([
    planner ? listEmployees(ctx) : Promise.resolve([]),
    listQualifications(ctx),
    planner ? listTemplates(ctx) : Promise.resolve([]),
  ]);
  const hm = (d: Date) => { const p = localParts(d, tz); return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`; };
  const byShift = new Map<string, typeof check.violations>();
  for (const v of check.violations) for (const sid of v.shiftIds) byShift.set(sid, [...(byShift.get(sid) ?? []), v]);
  const days = [...new Set(roster.shifts.map((s) => s.localDate.toISOString().slice(0, 10)))];
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const start = roster.startDate.toISOString().slice(0, 10), end = roster.endDate.toISOString().slice(0, 10);

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{roster.site.name}: {start} bis {end}</h1>
        <p className="text-sm text-muted">
          {roster.publishedVersion === 0 ? "Entwurf – noch nicht veröffentlicht" : `Veröffentlicht: Version ${roster.publishedVersion}`}
          {roster.dirty && roster.publishedVersion > 0 ? " · es gibt unveröffentlichte Änderungen (Mitarbeiter sehen noch die letzte Version)" : ""}
          {` · Zeiten in ${tz}`}
        </p>
      </div>
      <ErrorBanner message={error} />

      <section aria-label="Prüfergebnis" className="rounded-xl border border-line bg-surface p-4 text-sm">
        <p className="font-medium">{check.errors} Regelverstöße · {check.warnings} Hinweise</p>
        {check.violations.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {[...new Map(check.violations.map((v) => [`${v.code}:${v.message}:${v.employeeId ?? ""}`, v])).values()].map((v, i) => (
              <li key={i} className={v.severity === "ERROR" ? "text-red-700 dark:text-red-400" : "text-muted"}>
                <strong>{v.severity === "ERROR" ? "Fehler" : "Hinweis"}:</strong> {v.employeeId && people.get(v.employeeId) ? `${people.get(v.employeeId)!.firstName} ${people.get(v.employeeId)!.lastName}: ` : ""}{v.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {can(ctx, "roster.publish") && (
        <form action={publish} className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="rosterId" value={roster.id} />
          <label className="grow">Hinweis zur Änderung (optional)<input name="reason" maxLength={200} className={input + " w-full"} /></label>
          <button className={primary} disabled={!roster.dirty && roster.publishedVersion > 0}>Veröffentlichen</button>
        </form>
      )}

      {planner && (
        <form action={add} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
          <input type="hidden" name="rosterId" value={roster.id} />
          <label>Datum<input type="date" name="date" required min={start} max={end} className={input} /></label>
          <label>Beginn<input type="time" name="startTime" required defaultValue="08:00" className={input} /></label>
          <label>Ende<input type="time" name="endTime" required defaultValue="16:30" className={input} /></label>
          <label>Pause (min)<input name="breakMinutes" type="number" min={0} defaultValue={30} className={input} /></label>
          <label>Personen<input name="requiredCount" type="number" min={1} defaultValue={1} className={input} /></label>
          <label>Qualifikation<select name="qualificationId" className={input}><option value="">–</option>{quals.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}</select></label>
          <label className="sm:col-span-3">Bezeichnung<input name="label" maxLength={80} placeholder={templates.length ? `z. B. ${templates[0]!.name}` : "z. B. Frühdienst"} className={input + " w-full"} /></label>
          <div className="sm:col-span-3 self-end"><button className={primary}>Schicht hinzufügen</button></div>
        </form>
      )}

      {roster.shifts.length === 0 ? <p className="text-sm text-muted">Noch keine Schichten.</p> : days.map((day) => (
        <section key={day} className="space-y-2">
          <h2 className="font-medium">{new Date(`${day}T00:00:00Z`).toLocaleDateString("de-AT", { timeZone: "UTC", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" })}</h2>
          <ul className="space-y-2">
            {roster.shifts.filter((s) => s.localDate.toISOString().slice(0, 10) === day).map((s) => {
              const issues = byShift.get(s.id) ?? [];
              const assignedIds = new Set(s.assignments.map((a) => a.employeeId));
              return (
                <li key={s.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p><strong>{hm(s.startAt)}–{hm(s.endAt)}</strong> · Pause {s.breakMinutes} min · {s.assignments.length}/{s.requiredCount} Personen{s.label ? ` · ${s.label}` : ""}{s.qualification ? ` · Qualifikation: ${s.qualification.name}` : ""}</p>
                    {planner && <form action={remove}><input type="hidden" name="rosterId" value={roster.id} /><input type="hidden" name="shiftId" value={s.id} /><button className="rounded-md border border-line px-2 py-0.5">Schicht löschen</button></form>}
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {s.assignments.map((a) => {
                      const p = people.get(a.employeeId);
                      return (
                        <li key={a.id} className="flex items-center gap-1 rounded-full border border-line px-3 py-0.5">
                          {p ? `${p.firstName} ${p.lastName}` : "?"}
                          {planner && <form action={unassign}><input type="hidden" name="rosterId" value={roster.id} /><input type="hidden" name="shiftId" value={s.id} /><input type="hidden" name="employeeId" value={a.employeeId} /><button aria-label={`${p?.firstName ?? ""} ${p?.lastName ?? ""} entfernen`} className="px-1 text-muted">×</button></form>}
                        </li>
                      );
                    })}
                  </ul>
                  {planner && (
                    <form action={assign} className="mt-2 flex items-center gap-2">
                      <input type="hidden" name="rosterId" value={roster.id} /><input type="hidden" name="shiftId" value={s.id} />
                      <select name="employeeId" required aria-label={`Person für Schicht ${hm(s.startAt)} am ${day} zuweisen`} className="rounded-md border border-line bg-bg px-2 py-1">
                        <option value="">Person zuweisen …</option>
                        {employees.filter((e) => e.active && !assignedIds.has(e.id)).map((e) => <option key={e.id} value={e.id}>{e.lastName} {e.firstName}</option>)}
                      </select>
                      <button className="rounded-md border border-line px-2 py-1">Zuweisen</button>
                    </form>
                  )}
                  {issues.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-muted">{[...new Set(issues.map((v) => v.message))].map((m) => <li key={m}>{m}</li>)}</ul>}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section className="space-y-2">
        <h2 className="font-medium">Versionen</h2>
        {roster.versions.length === 0 ? <p className="text-sm text-muted">Noch nicht veröffentlicht.</p> : (
          <ul className="text-sm text-muted">
            {roster.versions.map((v) => {
              const ch = v.changes as { reason?: string; added?: unknown[]; removed?: unknown[] };
              return <li key={v.version}>Version {v.version} · {v.publishedAt.toLocaleString("de-AT", { timeZone: ctx.timeZone })} · {ch.reason ?? ""} (+{ch.added?.length ?? 0} / −{ch.removed?.length ?? 0} Zuweisungen)</li>;
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
