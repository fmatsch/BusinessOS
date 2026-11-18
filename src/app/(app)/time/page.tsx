import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { runOutbox } from "@/modules/events";
import { listCostCenters } from "@/modules/masterdata/service";
import {
  cancelRequest, clockIn, clockOut, discardClock, endBreak, getClock, getEmployeeTime, getMyEmployeeId, requestEntry, startBreak, submitPeriod,
} from "@/modules/time/service";
import { ErrorBanner, runAction } from "../action-helpers";
import { DayTable, EntryTable, Hints, MonthNav, parseMonth, Summary, ymKey, fmtMin } from "./_shared";

export const dynamic = "force-dynamic";
const BACK = "/time";

async function inAction(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => clockIn(ctx, { costCenterId: formData.get("costCenterId") || null }));
  revalidatePath(BACK);
}
async function breakStart() { "use server"; const ctx = await requireContext(); await runAction(BACK, () => startBreak(ctx)); revalidatePath(BACK); }
async function breakEnd() { "use server"; const ctx = await requireContext(); await runAction(BACK, () => endBreak(ctx)); revalidatePath(BACK); }
async function outAction() { "use server"; const ctx = await requireContext(); await runAction(BACK, () => clockOut(ctx)); revalidatePath(BACK); }
async function discard() { "use server"; const ctx = await requireContext(); await runAction(BACK, () => discardClock(ctx)); revalidatePath(BACK); }

async function request(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const type = String(formData.get("type"));
  const base = { reason: formData.get("reason") };
  const iv = { date: formData.get("date"), startTime: formData.get("startTime"), endTime: formData.get("endTime"), breakMinutes: formData.get("breakMinutes") || 0, costCenterId: formData.get("costCenterId") || null };
  const input = type === "DELETE" ? { type, targetEntryId: formData.get("targetEntryId"), ...base } : type === "CORRECT" ? { type, targetEntryId: formData.get("targetEntryId"), ...iv, ...base } : { type: "ADD", ...iv, ...base };
  await runAction(BACK, () => requestEntry(ctx, input));
  after(() => runOutbox());
  revalidatePath(BACK);
}
async function cancel(formData: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => cancelRequest(ctx, String(formData.get("requestId")))); revalidatePath(BACK); }
async function submit(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => submitPeriod(ctx, { year: formData.get("year"), month: formData.get("month") }));
  after(() => runOutbox());
  revalidatePath(BACK);
}

const TYPE: Record<string, string> = { ADD: "Nachtrag", CORRECT: "Korrektur", DELETE: "Löschung" };
const STATUS: Record<string, string> = { PENDING: "offen", APPROVED: "genehmigt", REJECTED: "abgelehnt", CANCELLED: "zurückgezogen" };

export default async function TimePage({ searchParams }: { searchParams: Promise<{ error?: string; month?: string }> }) {
  const { error, month: monthParam } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "time.entry.own")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const meId = await getMyEmployeeId(ctx);
  if (!meId) return <p role="status" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">Ihrem Benutzerkonto ist kein Mitarbeiterprofil zugeordnet. Bitte wenden Sie sich an das Personalwesen.</p>;
  const { year, month } = parseMonth(monthParam, ctx.timeZone);
  const [v, clock, costCenters] = await Promise.all([
    getEmployeeTime(ctx, meId, year, month),
    getClock(ctx),
    can(ctx, "master.costcenter.read") ? listCostCenters(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const secondary = "rounded-md border border-line px-3 py-1.5";
  const since = clock?.startedAt.toLocaleString("de-AT", { timeZone: ctx.timeZone, dateStyle: "short", timeStyle: "short" });
  const locked = v.period?.status === "APPROVED" || v.period?.status === "SUBMITTED";

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Zeiterfassung</h1>
      <ErrorBanner message={error} />

      <section aria-label="Stempeluhr" className="rounded-xl border border-line bg-surface p-4">
        {!clock ? (
          <form action={inAction} className="flex flex-wrap items-end gap-3 text-sm">
            <p className="grow font-medium">Nicht eingestempelt</p>
            {costCenters.length > 0 && <label>Kostenstelle<select name="costCenterId" className={input}><option value="">–</option>{costCenters.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></label>}
            <button className={primary}>Einstempeln</button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="grow font-medium">Eingestempelt seit {since}{clock.breakStartedAt ? " · in Pause" : ""}{clock.breakMinutes ? ` · Pause bisher ${clock.breakMinutes} min` : ""}</p>
            {clock.breakStartedAt ? <form action={breakEnd}><button className={secondary}>Pause beenden</button></form> : <form action={breakStart}><button className={secondary}>Pause beginnen</button></form>}
            <form action={outAction}><button className={primary}>Ausstempeln</button></form>
            <form action={discard}><button className={secondary}>Verwerfen</button></form>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <MonthNav base="/time" year={year} month={month} />
        {(!v.period || v.period.status === "OPEN") && (
          <form action={submit}><input type="hidden" name="year" value={year} /><input type="hidden" name="month" value={month} /><button className={secondary}>Monat {ymKey(year, month)} einreichen</button></form>
        )}
      </div>

      <Summary v={v} />
      <Hints v={v} />
      <DayTable v={v} />

      <section className="space-y-2">
        <h2 className="font-medium">Meine Buchungen</h2>
        <EntryTable v={v} actions={(e) => !locked && (
          <details>
            <summary className="cursor-pointer text-accent underline">Ändern …</summary>
            <form action={request} className="mt-2 grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-5">
              <input type="hidden" name="targetEntryId" value={e.id} />
              <input type="hidden" name="date" value={e.localDate.toISOString().slice(0, 10)} />
              <label>Beginn<input type="time" name="startTime" required defaultValue={e.startAt.toLocaleTimeString("de-AT", { timeZone: ctx.timeZone, hour: "2-digit", minute: "2-digit" })} className={input} /></label>
              <label>Ende<input type="time" name="endTime" required defaultValue={e.endAt.toLocaleTimeString("de-AT", { timeZone: ctx.timeZone, hour: "2-digit", minute: "2-digit" })} className={input} /></label>
              <label>Pause (min)<input name="breakMinutes" type="number" min={0} defaultValue={e.breakMinutes} className={input} /></label>
              <label className="sm:col-span-2">Begründung<input name="reason" required minLength={3} maxLength={300} className={input + " w-full"} /></label>
              <div className="flex gap-2 sm:col-span-5"><button name="type" value="CORRECT" className={primary}>Korrektur beantragen</button><button name="type" value="DELETE" className={secondary}>Löschung beantragen</button></div>
            </form>
          </details>
        )} />
      </section>

      {!locked && (
        <section className="space-y-2">
          <h2 className="font-medium">Zeit nachtragen</h2>
          <form action={request} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
            <input type="hidden" name="type" value="ADD" />
            <label>Datum<input type="date" name="date" required className={input} /></label>
            <label>Beginn<input type="time" name="startTime" required className={input} /></label>
            <label>Ende<input type="time" name="endTime" required className={input} /></label>
            <label>Pause (min)<input name="breakMinutes" type="number" min={0} defaultValue={0} className={input} /></label>
            <label className="sm:col-span-2">Begründung<input name="reason" required minLength={3} maxLength={300} className={input + " w-full"} /></label>
            <div className="sm:col-span-6"><button className={primary}>Antrag stellen</button> <span className="text-muted">Nachträge und Korrekturen werden von Ihrer Führungskraft freigegeben.</span></div>
          </form>
        </section>
      )}
      {locked && <p className="text-sm text-muted">Dieser Monat ist {v.period?.status === "APPROVED" ? "freigegeben und gesperrt" : "eingereicht"}; Änderungen sind nur über das Personalwesen möglich.</p>}

      {v.requests.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Meine Anträge</h2>
          <ul className="space-y-1 text-sm">
            {v.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3">
                <span>{TYPE[r.type]} · {r.reason} · <em>{STATUS[r.status]}</em>{r.comment ? ` · „${r.comment}"` : ""}</span>
                {r.status === "PENDING" && <form action={cancel}><input type="hidden" name="requestId" value={r.id} /><button className="rounded-md border border-line px-2 py-0.5">Zurückziehen</button></form>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-muted">Gearbeitete Zeit je Tag: {fmtMin(v.summary.workedMinutes)} im Monat. Ihre Zeitdaten sind nur für Sie, Ihre direkte Führungskraft und das Personalwesen sichtbar; Zugriffe anderer werden protokolliert.</p>
    </div>
  );
}
