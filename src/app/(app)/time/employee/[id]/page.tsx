import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { runOutbox } from "@/modules/events";
import {
  addAccountAdjustment, addEntryDirect, approvePeriod, correctEntryDirect, deleteEntryDirect, getEmployeeTime, listAccountEntries, reopenPeriod, returnPeriod,
} from "@/modules/time/service";
import { ErrorBanner, runAction } from "../../../action-helpers";
import { DayTable, EntryTable, fmtMin, Hints, MonthNav, parseMonth, Summary } from "../../_shared";

export const dynamic = "force-dynamic";

function key(formData: FormData) {
  return { employeeId: formData.get("employeeId"), year: formData.get("year"), month: formData.get("month") };
}
const back = (formData: FormData) => `/time/employee/${formData.get("employeeId")}?month=${formData.get("year")}-${String(formData.get("month")).padStart(2, "0")}`;

async function approve(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(back(formData), () => approvePeriod(ctx, key(formData)));
  after(() => runOutbox());
  revalidatePath("/time", "layout");
}
async function giveBack(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(back(formData), () => returnPeriod(ctx, { ...key(formData), comment: formData.get("comment") }));
  after(() => runOutbox());
  revalidatePath("/time", "layout");
}
async function reopen(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(back(formData), () => reopenPeriod(ctx, { ...key(formData), reason: formData.get("reason") }));
  after(() => runOutbox());
  revalidatePath("/time", "layout");
}
async function add(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(back(formData), () => addEntryDirect(ctx, {
    employeeId: formData.get("employeeId"), date: formData.get("date"), startTime: formData.get("startTime"), endTime: formData.get("endTime"),
    breakMinutes: formData.get("breakMinutes") || 0, costCenterId: null, reason: formData.get("reason"),
  }));
  revalidatePath("/time", "layout");
}
async function correct(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const base = { entryId: formData.get("entryId"), reason: formData.get("reason") };
  await runAction(back(formData), async () => {
    if (formData.get("op") === "DELETE") await deleteEntryDirect(ctx, base);
    else await correctEntryDirect(ctx, { ...base, date: formData.get("date"), startTime: formData.get("startTime"), endTime: formData.get("endTime"), breakMinutes: formData.get("breakMinutes") || 0, costCenterId: null });
  });
  revalidatePath("/time", "layout");
}
async function adjust(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const sign = formData.get("direction") === "minus" ? -1 : 1;
  await runAction(back(formData), () => addAccountAdjustment(ctx, { employeeId: formData.get("employeeId"), minutes: sign * Number(formData.get("minutes")), note: formData.get("note") }));
  revalidatePath("/time", "layout");
}

export default async function EmployeeTimePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; month?: string }> }) {
  const [{ id }, { error, month: monthParam }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  const { year, month } = parseMonth(monthParam, ctx.timeZone);
  let v;
  try { v = await getEmployeeTime(ctx, id, year, month); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const status = v.period?.status ?? "OPEN";
  const direct = can(ctx, "time.entry.correct") && status !== "APPROVED";
  const account = can(ctx, "time.account.write") ? await listAccountEntries(ctx, id) : [];
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const secondary = "rounded-md border border-line px-3 py-1.5";
  const hidden = (<><input type="hidden" name="employeeId" value={id} /><input type="hidden" name="year" value={year} /><input type="hidden" name="month" value={month} /></>);

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Zeiten: {v.employee.firstName} {v.employee.lastName}</h1>
      <ErrorBanner message={error} />
      <MonthNav base={`/time/employee/${id}`} year={year} month={month} />
      <Summary v={v} />
      <Hints v={v} />

      {status === "SUBMITTED" && !v.self && (
        <section className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-medium">Monatsabschluss prüfen</h2>
          <form action={approve} className="inline">{hidden}<button className={primary}>Freigeben und sperren</button></form>
          <form action={giveBack} className="mt-3 flex flex-wrap items-end gap-2">
            {hidden}
            <label className="grow">Grund für die Rückgabe<input name="comment" required minLength={3} maxLength={300} className={input + " w-full"} /></label>
            <button className={secondary}>An Mitarbeiter zurückgeben</button>
          </form>
        </section>
      )}
      {status === "APPROVED" && can(ctx, "time.period.reopen") && (
        <form action={reopen} className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-4 text-sm">
          {hidden}
          <label className="grow">Begründung für das Wiederöffnen<input name="reason" required minLength={3} maxLength={300} className={input + " w-full"} /></label>
          <button className={secondary}>Monat wieder öffnen</button>
        </form>
      )}

      <DayTable v={v} />
      <section className="space-y-2">
        <h2 className="font-medium">Buchungen</h2>
        <EntryTable v={v} actions={(e) => direct && (
          <details>
            <summary className="cursor-pointer text-accent underline">Korrigieren …</summary>
            <form action={correct} className="mt-2 grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-5">
              {hidden}
              <input type="hidden" name="entryId" value={e.id} />
              <input type="hidden" name="date" value={e.localDate.toISOString().slice(0, 10)} />
              <label>Beginn<input type="time" name="startTime" required defaultValue={e.startAt.toLocaleTimeString("de-AT", { timeZone: v.tz, hour: "2-digit", minute: "2-digit" })} className={input} /></label>
              <label>Ende<input type="time" name="endTime" required defaultValue={e.endAt.toLocaleTimeString("de-AT", { timeZone: v.tz, hour: "2-digit", minute: "2-digit" })} className={input} /></label>
              <label>Pause (min)<input name="breakMinutes" type="number" min={0} defaultValue={e.breakMinutes} className={input} /></label>
              <label className="sm:col-span-2">Begründung<input name="reason" required minLength={3} maxLength={300} className={input + " w-full"} /></label>
              <div className="flex gap-2 sm:col-span-5"><button name="op" value="CORRECT" className={primary}>Korrigieren</button><button name="op" value="DELETE" className={secondary}>Stornieren</button></div>
            </form>
          </details>
        )} />
      </section>

      {direct && (
        <section className="space-y-2">
          <h2 className="font-medium">Buchung direkt erfassen</h2>
          <form action={add} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
            {hidden}
            <label>Datum<input type="date" name="date" required className={input} /></label>
            <label>Beginn<input type="time" name="startTime" required className={input} /></label>
            <label>Ende<input type="time" name="endTime" required className={input} /></label>
            <label>Pause (min)<input name="breakMinutes" type="number" min={0} defaultValue={0} className={input} /></label>
            <label className="sm:col-span-2">Begründung<input name="reason" required minLength={3} maxLength={300} className={input + " w-full"} /></label>
            <div className="sm:col-span-6"><button className={primary}>Erfassen</button></div>
          </form>
        </section>
      )}

      {can(ctx, "time.account.write") && (
        <section className="space-y-2">
          <h2 className="font-medium">Zeitkonto</h2>
          <form action={adjust} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
            {hidden}
            <label>Richtung<select name="direction" className={input}><option value="plus">Gutschrift (+)</option><option value="minus">Abzug (−)</option></select></label>
            <label>Minuten<input name="minutes" type="number" min={1} required className={input} /></label>
            <label className="grow">Begründung<input name="note" required minLength={3} maxLength={300} className={input + " w-full"} /></label>
            <button className={primary}>Buchen</button>
          </form>
          {account.length > 0 && (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2">Datum</th><th>Art</th><th>Monat</th><th className="text-right">Minuten</th><th>Hinweis</th></tr></thead>
              <tbody className="divide-y divide-line">
                {account.map((a) => (
                  <tr key={a.id}><td className="py-2">{a.createdAt.toLocaleDateString("de-AT", { timeZone: ctx.timeZone })}</td><td>{a.kind === "PERIOD" ? "Monatsabschluss" : a.kind === "REVERSAL" ? "Gegenbuchung" : "Korrektur"}</td>
                    <td>{a.year ? `${a.month}/${a.year}` : ""}</td><td className="text-right">{fmtMin(a.minutes, true)}</td><td>{a.note ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
