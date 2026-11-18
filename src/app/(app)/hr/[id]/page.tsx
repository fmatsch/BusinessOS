import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import {
  addEmployment, addLeaveEntry, closeEmployment, getEmployee, leaveBalance, listEmployees, listEmployments, listLeaveEntries,
  readSensitive, updateEmployee, writeSensitive,
} from "@/modules/hr/service";
import { listDepartments } from "@/modules/masterdata/service";
import { listCostCenters } from "@/modules/masterdata/service";
import { isoFromDate } from "@/modules/hr/calendar";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const CONTRACTS: Record<string, string> = { FULL_TIME: "Vollzeit", PART_TIME: "Teilzeit", MARGINAL: "Geringfügig", APPRENTICE: "Lehrling", OTHER: "Sonstige" };
const KINDS: Record<string, string> = { ENTITLEMENT: "Anspruch", CARRYOVER: "Übertrag", ADJUSTMENT: "Korrektur", TAKEN: "Verbraucht", REVERSAL: "Storno" };

/** Liefert null, wenn der Benutzer den Abschnitt nicht sehen darf – so bleibt der Rest der Seite benutzbar. */
async function allowed<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) { if (e instanceof ForbiddenError) return null; throw e; }
}

async function save(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("id"));
  await runAction(`/hr/${id}`, () => updateEmployee(ctx, id, {
    firstName: formData.get("firstName"), lastName: formData.get("lastName"), email: formData.get("email"), jobTitle: formData.get("jobTitle"),
    departmentId: formData.get("departmentId") || null, managerId: formData.get("managerId") || null, userId: formData.get("userId") || null,
    active: formData.get("active") === "on",
  }));
  revalidatePath(`/hr/${id}`);
}
async function saveSensitive(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("id"));
  await runAction(`/hr/${id}`, () => writeSensitive(ctx, id, {
    birthDate: formData.get("birthDate"), addressLine: formData.get("addressLine"), phone: formData.get("phone"), emergencyContact: formData.get("emergencyContact"),
  }));
  revalidatePath(`/hr/${id}`);
}
async function employ(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("id"));
  await runAction(`/hr/${id}`, () => addEmployment(ctx, {
    employeeId: id, validFrom: formData.get("validFrom"), validTo: formData.get("validTo") || null, contractType: formData.get("contractType"),
    weeklyHours: formData.get("weeklyHours"), costCenterId: formData.get("costCenterId") || null,
  }));
  revalidatePath(`/hr/${id}`);
}
async function close(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("id"));
  await runAction(`/hr/${id}`, () => closeEmployment(ctx, String(formData.get("employmentId")), String(formData.get("validTo"))));
  revalidatePath(`/hr/${id}`);
}
async function leave(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("id"));
  await runAction(`/hr/${id}`, () => addLeaveEntry(ctx, {
    employeeId: id, year: formData.get("year"), kind: formData.get("kind"), days: formData.get("days"), note: formData.get("note"),
  }));
  revalidatePath(`/hr/${id}`);
}

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let e;
  try { e = await getEmployee(ctx, id); } catch (err) {
    if (err instanceof NotFoundError) notFound();
    if (err instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw err;
  }
  const year = new Date().getFullYear();
  const writer = can(ctx, "hr.employee.write");
  const [employments, sensitive, balance, entries, departments, costCenters, people] = await Promise.all([
    allowed(() => listEmployments(ctx, id)),
    allowed(() => readSensitive(ctx, id)),
    allowed(() => leaveBalance(ctx, id, year)),
    allowed(() => listLeaveEntries(ctx, id, year)),
    writer && can(ctx, "master.department.read") ? listDepartments(ctx) : Promise.resolve([]),
    can(ctx, "hr.employment.write") && can(ctx, "master.costcenter.read") ? listCostCenters(ctx) : Promise.resolve([]),
    writer ? listEmployees(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{e.firstName} {e.lastName}</h1>
        <p className="text-sm text-muted">Nr. {e.number} · {e.jobTitle ?? "ohne Position"} · {e.department?.name ?? "ohne Abteilung"} · {e.active ? "aktiv" : "inaktiv"}</p>
      </div>
      <ErrorBanner message={error} />

      {writer && (
        <section className="space-y-2">
          <h2 className="font-medium">Stammdaten</h2>
          <form action={save} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3">
            <input type="hidden" name="id" value={e.id} />
            <input type="hidden" name="userId" value={e.userId ?? ""} />
            <label>Vorname<input name="firstName" defaultValue={e.firstName} required className={input} /></label>
            <label>Nachname<input name="lastName" defaultValue={e.lastName} required className={input} /></label>
            <label>E-Mail<input name="email" type="email" defaultValue={e.email ?? ""} className={input} /></label>
            <label>Position<input name="jobTitle" defaultValue={e.jobTitle ?? ""} className={input} /></label>
            <label>Abteilung
              <select name="departmentId" defaultValue={e.departmentId ?? ""} className={input}><option value="">–</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
            </label>
            <label>Führungskraft
              <select name="managerId" defaultValue={e.manager?.id ?? ""} className={input}><option value="">–</option>{people.filter((p) => p.id !== e.id && p.active).map((p) => <option key={p.id} value={p.id}>{p.lastName} {p.firstName}</option>)}</select>
            </label>
            <label className="flex items-center gap-2 sm:col-span-3"><input type="checkbox" name="active" defaultChecked={e.active} /> Aktiv</label>
            <div className="sm:col-span-3"><button className={primary}>Speichern</button></div>
          </form>
        </section>
      )}

      {employments && (
        <section className="space-y-2">
          <h2 className="font-medium">Beschäftigung</h2>
          {employments.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2">Von</th><th>Bis</th><th>Art</th><th>Wochenstunden</th><th>Kostenstelle</th><th /></tr></thead>
              <tbody className="divide-y divide-line">
                {employments.map((m) => (
                  <tr key={m.id}>
                    <td className="py-2">{isoFromDate(m.validFrom)}</td><td>{m.validTo ? isoFromDate(m.validTo) : "offen"}</td>
                    <td>{CONTRACTS[m.contractType]}</td><td>{m.weeklyHours.toString()}</td><td>{m.costCenter?.code ?? "–"}</td>
                    <td>{!m.validTo && can(ctx, "hr.employment.write") && (
                      <form action={close} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={e.id} /><input type="hidden" name="employmentId" value={m.id} />
                        <input type="date" name="validTo" required aria-label="Beenden am" className="rounded-md border border-line bg-bg px-1 py-0.5" />
                        <button className="rounded-md border border-line px-2 py-0.5">Beenden</button>
                      </form>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {can(ctx, "hr.employment.write") && (
            <form action={employ} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-5">
              <input type="hidden" name="id" value={e.id} />
              <label>Von<input type="date" name="validFrom" required className={input} /></label>
              <label>Bis (optional)<input type="date" name="validTo" className={input} /></label>
              <label>Art<select name="contractType" className={input}>{Object.entries(CONTRACTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <label>Wochenstunden<input name="weeklyHours" required inputMode="decimal" defaultValue="38.5" className={input} /></label>
              <label>Kostenstelle<select name="costCenterId" className={input}><option value="">–</option>{costCenters.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></label>
              <div className="sm:col-span-5"><button className={primary}>Zeitraum hinzufügen</button></div>
            </form>
          )}
        </section>
      )}

      {sensitive && (
        <section className="space-y-2">
          <h2 className="font-medium">Persönliche Angaben</h2>
          <p className="text-sm text-muted">Besonders geschützt. Jeder Abruf wird im Audit-Log protokolliert.</p>
          {can(ctx, "hr.employee.write_sensitive") ? (
            <form action={saveSensitive} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-2">
              <input type="hidden" name="id" value={e.id} />
              <label>Geburtsdatum<input type="date" name="birthDate" defaultValue={sensitive.birthDate ?? ""} className={input} /></label>
              <label>Telefon<input name="phone" defaultValue={sensitive.phone ?? ""} maxLength={40} className={input} /></label>
              <label>Adresse<input name="addressLine" defaultValue={sensitive.addressLine ?? ""} maxLength={200} className={input} /></label>
              <label>Notfallkontakt<input name="emergencyContact" defaultValue={sensitive.emergencyContact ?? ""} maxLength={200} className={input} /></label>
              <div className="sm:col-span-2"><button className={primary}>Speichern</button></div>
            </form>
          ) : (
            <dl className="grid gap-1 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-2">
              <div><dt className="text-muted">Geburtsdatum</dt><dd>{sensitive.birthDate ?? "–"}</dd></div>
              <div><dt className="text-muted">Telefon</dt><dd>{sensitive.phone ?? "–"}</dd></div>
              <div><dt className="text-muted">Adresse</dt><dd>{sensitive.addressLine ?? "–"}</dd></div>
              <div><dt className="text-muted">Notfallkontakt</dt><dd>{sensitive.emergencyContact ?? "–"}</dd></div>
            </dl>
          )}
        </section>
      )}

      {balance && entries && (
        <section className="space-y-2">
          <h2 className="font-medium">Urlaubskonto {year}</h2>
          <p className="text-sm">
            Anspruch {balance.entitlement.toString()} · verbraucht {balance.taken.toString()} · beantragt {balance.reserved.toString()} ·
            <strong> verfügbar {balance.available.toString()} Tage</strong>
          </p>
          {entries.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2">Datum</th><th>Art</th><th className="text-right">Tage</th><th>Hinweis</th></tr></thead>
              <tbody className="divide-y divide-line">
                {entries.map((x) => (
                  <tr key={x.id}><td className="py-2">{x.createdAt.toLocaleDateString("de-AT", { timeZone: "Europe/Vienna" })}</td><td>{KINDS[x.kind]}</td><td className="text-right">{x.days.toString()}</td><td>{x.note ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {can(ctx, "hr.leave.write") && (
            <form action={leave} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-5">
              <input type="hidden" name="id" value={e.id} />
              <label>Jahr<input name="year" type="number" defaultValue={year} className={input} /></label>
              <label>Art<select name="kind" className={input}><option value="ENTITLEMENT">Anspruch</option><option value="CARRYOVER">Übertrag</option><option value="ADJUSTMENT">Korrektur (±)</option></select></label>
              <label>Tage<input name="days" required inputMode="decimal" className={input} /></label>
              <label className="sm:col-span-2">Hinweis<input name="note" maxLength={200} className={input} /></label>
              <div className="sm:col-span-5"><button className={primary}>Buchen</button> <span className="text-muted">Buchungen sind unveränderlich; Fehler werden per Korrekturbuchung behoben.</span></div>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
