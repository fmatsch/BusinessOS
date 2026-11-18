import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { runOutbox } from "@/modules/events";
import {
  cancelSwap, createRoster, decideSwap, listMyShifts, listRosters, listSites, listSwapCandidates, listSwaps, requestSwap, respondSwap,
} from "@/modules/roster/service";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { PENDING_PEER: "wartet auf Kollegin/Kollegen", PENDING_APPROVAL: "wartet auf Freigabe" };

async function create(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const r = await runAction("/roster", () => createRoster(ctx, { siteId: formData.get("siteId"), startDate: formData.get("startDate"), endDate: formData.get("endDate") }));
  redirect(`/roster/${r.id}`);
}
async function swap(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/roster", () => requestSwap(ctx, { shiftId: formData.get("shiftId"), toEmployeeId: formData.get("toEmployeeId"), note: formData.get("note") }));
  after(() => runOutbox());
  revalidatePath("/roster");
}
async function respond(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/roster", () => respondSwap(ctx, String(formData.get("swapId")), formData.get("answer") === "yes"));
  after(() => runOutbox());
  revalidatePath("/roster");
}
async function decide(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/roster", () => decideSwap(ctx, String(formData.get("swapId")), formData.get("answer") === "yes"));
  after(() => runOutbox());
  revalidatePath("/roster");
}
async function cancel(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/roster", () => cancelSwap(ctx, String(formData.get("swapId"))));
  revalidatePath("/roster");
}

export default async function RosterPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  const tz = ctx.timeZone;
  const dt = (d: Date) => d.toLocaleString("de-AT", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const tm = (d: Date) => d.toLocaleTimeString("de-AT", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const planner = can(ctx, "roster.plan");
  const reader = planner || can(ctx, "roster.read_all");
  const [mine, swaps, candidates, rosters, sites] = await Promise.all([
    listMyShifts(ctx),
    listSwaps(ctx),
    can(ctx, "roster.swap.request") ? listSwapCandidates(ctx) : Promise.resolve([]),
    reader ? listRosters(ctx) : Promise.resolve([]),
    planner ? listSites(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const secondary = "rounded-md border border-line px-3 py-1.5";
  const pendingByShift = new Set(swaps.mine.filter((s) => s.fromEmployeeId === swaps.me?.id).map((s) => s.shiftId));

  return (
    <div className="max-w-5xl space-y-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Dienstplan</h1>
        {planner && <Link className="text-sm text-accent underline" href="/roster/settings">Einstellungen</Link>}
      </div>
      <ErrorBanner message={error} />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Mein Dienstplan</h2>
          {swaps.me && <a className="text-sm text-accent underline" href="/roster/my.ics" download="dienstplan.ics">Kalender herunterladen (.ics)</a>}
        </div>
        {!swaps.me && <p className="text-sm text-muted">Ihrem Benutzerkonto ist kein Mitarbeiterprofil zugeordnet.</p>}
        {swaps.me && mine.length === 0 && <p className="text-sm text-muted">Keine kommenden veröffentlichten Schichten.</p>}
        {mine.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Beginn</th><th>Ende</th><th>Standort</th><th>Bezeichnung</th><th>Tausch</th></tr></thead>
            <tbody className="divide-y divide-line">
              {mine.map((s) => (
                <tr key={s.id}>
                  <td className="py-2">{dt(s.startAt)}</td><td>{tm(s.endAt)}</td><td>{s.siteName}</td><td>{s.label ?? "–"}</td>
                  <td>
                    {can(ctx, "roster.swap.request") && !pendingByShift.has(s.shiftId) && (
                      <form action={swap} className="flex items-center gap-1">
                        <input type="hidden" name="shiftId" value={s.shiftId} />
                        <select name="toEmployeeId" required aria-label={`Tauschen mit (Schicht ${dt(s.startAt)})`} className="rounded-md border border-line bg-bg px-1 py-0.5">
                          <option value="">tauschen mit …</option>
                          {candidates.map((c) => <option key={c.id} value={c.id}>{c.lastName} {c.firstName}</option>)}
                        </select>
                        <button className="rounded-md border border-line px-2 py-0.5">Anfragen</button>
                      </form>
                    )}
                    {pendingByShift.has(s.shiftId) && <span className="text-muted">Anfrage offen</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {swaps.mine.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Tauschanfragen</h2>
          <ul className="space-y-2 text-sm">
            {swaps.mine.map((s) => {
              const incoming = s.toEmployeeId === swaps.me?.id;
              return (
                <li key={s.id} className="rounded-xl border border-line bg-surface p-3">
                  <p>
                    {incoming ? `${swaps.people.get(s.fromEmployeeId)} möchte Schicht abgeben` : `Anfrage an ${swaps.people.get(s.toEmployeeId)}`}: {s.roster.site.name}, {dt(s.shift.startAt)}–{tm(s.shift.endAt)} · <em>{STATUS[s.status]}</em>
                    {s.note ? ` · „${s.note}"` : ""}
                  </p>
                  <div className="mt-2 flex gap-2">
                    {incoming && s.status === "PENDING_PEER" && (
                      <form action={respond} className="flex gap-2"><input type="hidden" name="swapId" value={s.id} />
                        <button name="answer" value="yes" className={primary}>Übernehmen</button><button name="answer" value="no" className={secondary}>Ablehnen</button></form>
                    )}
                    {!incoming && <form action={cancel}><input type="hidden" name="swapId" value={s.id} /><button className={secondary}>Zurückziehen</button></form>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {swaps.approvable.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Tausch wartet auf Ihre Freigabe</h2>
          <ul className="space-y-2 text-sm">
            {swaps.approvable.map((s) => (
              <li key={s.id} className="rounded-xl border border-line bg-surface p-3">
                <p>{swaps.people.get(s.fromEmployeeId)} ↔ {swaps.people.get(s.toEmployeeId)}: {s.roster.site.name}, {dt(s.shift.startAt)}–{tm(s.shift.endAt)}</p>
                <form action={decide} className="mt-2 flex gap-2"><input type="hidden" name="swapId" value={s.id} />
                  <button name="answer" value="yes" className={primary}>Freigeben</button><button name="answer" value="no" className={secondary}>Ablehnen</button></form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {reader && (
        <section className="space-y-3">
          <h2 className="font-medium">Dienstpläne</h2>
          {planner && (
            sites.length === 0 ? <p className="text-sm text-muted">Legen Sie zuerst unter „Einstellungen" einen Standort an.</p> : (
              <form action={create} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
                <label>Standort<select name="siteId" required className={input}>{sites.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                <label>Von<input type="date" name="startDate" required className={input} /></label>
                <label>Bis<input type="date" name="endDate" required className={input} /></label>
                <button className={primary}>Plan anlegen</button>
              </form>
            )
          )}
          {rosters.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2">Standort</th><th>Zeitraum</th><th>Schichten</th><th>Stand</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rosters.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2"><Link className="text-accent underline" href={`/roster/${r.id}`}>{r.site.name}</Link></td>
                    <td>{r.startDate.toISOString().slice(0, 10)} bis {r.endDate.toISOString().slice(0, 10)}</td>
                    <td>{r._count.shifts}</td>
                    <td>{r.publishedVersion === 0 ? "Entwurf" : `Version ${r.publishedVersion}`}{r.dirty && r.publishedVersion > 0 ? " · ungeveröffentlichte Änderungen" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
