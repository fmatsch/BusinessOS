import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { runOutbox } from "@/modules/events";
import {
  cancelAbsence, decideAbsence, getSelfEmployee, leaveBalance, listAbsenceTypes, listAbsences, listPendingAbsenceApprovals, requestAbsence,
} from "@/modules/hr/service";
import { isoFromDate } from "@/modules/hr/calendar";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const STATUS: Record<string, string> = { PENDING: "offen", APPROVED: "genehmigt", REJECTED: "abgelehnt", CANCELLED: "storniert" };

async function request(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/absences", () => requestAbsence(ctx, {
    typeKey: formData.get("typeKey"), startDate: formData.get("startDate"), endDate: formData.get("endDate"), note: formData.get("note"),
  }));
  after(() => runOutbox());
  revalidatePath("/absences");
}
async function decide(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/absences", () => decideAbsence(ctx, { absenceId: formData.get("absenceId"), decision: formData.get("decision"), comment: formData.get("comment") }));
  after(() => runOutbox());
  revalidatePath("/absences");
}
async function cancel(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/absences", () => cancelAbsence(ctx, String(formData.get("absenceId"))));
  after(() => runOutbox());
  revalidatePath("/absences");
}

type Row = Awaited<ReturnType<typeof listAbsences>>[number];

function Table({ rows, canCancel, showWho }: { rows: Row[]; canCancel: (r: Row) => boolean; showWho: boolean }) {
  if (rows.length === 0) return <p className="text-sm text-muted">Noch keine Einträge.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted"><tr>{showWho && <th className="py-2">Person</th>}<th className="py-2">Art</th><th>Von</th><th>Bis</th><th className="text-right">Arbeitstage</th><th>Status</th><th /></tr></thead>
      <tbody className="divide-y divide-line">
        {rows.map((r) => (
          <tr key={r.id}>
            {showWho && <td className="py-2">{r.employee.lastName} {r.employee.firstName}</td>}
            <td className="py-2">{r.type.name}</td><td>{isoFromDate(r.startDate)}</td><td>{isoFromDate(r.endDate)}</td>
            <td className="text-right">{r.days.toString()}</td><td>{STATUS[r.status]}</td>
            <td>{canCancel(r) && (
              <form action={cancel}><input type="hidden" name="absenceId" value={r.id} /><button className="rounded-md border border-line px-2 py-0.5">Stornieren</button></form>
            )}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function AbsencesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  const year = new Date().getFullYear();
  const me = await getSelfEmployee(ctx);
  const [types, balance, mine, pending, team, all] = await Promise.all([
    can(ctx, "hr.absence.request") ? listAbsenceTypes(ctx) : Promise.resolve([]),
    me ? leaveBalance(ctx, me.id, year) : Promise.resolve(null),
    listAbsences(ctx, "mine"),
    listPendingAbsenceApprovals(ctx),
    can(ctx, "hr.absence.approve") && !can(ctx, "hr.absence.read_all") ? listAbsences(ctx, "team") : Promise.resolve([]),
    can(ctx, "hr.absence.read_all") ? listAbsences(ctx, "all") : Promise.resolve([]),
  ]);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Abwesenheiten</h1>
      <ErrorBanner message={error} />

      {!me && <p role="status" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">Ihrem Benutzerkonto ist kein Mitarbeiterprofil zugeordnet. Bitte wenden Sie sich an das Personalwesen.</p>}

      {me && balance && (
        <section className="space-y-3">
          <h2 className="font-medium">Mein Urlaub {year}</h2>
          <p className="text-sm">Anspruch {balance.entitlement.toString()} · verbraucht {balance.taken.toString()} · beantragt {balance.reserved.toString()} · <strong>verfügbar {balance.available.toString()} Tage</strong></p>
          <form action={request} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-5">
            <label>Art<select name="typeKey" className={input}>{types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></label>
            <label>Von<input type="date" name="startDate" required className={input} /></label>
            <label>Bis<input type="date" name="endDate" required className={input} /></label>
            <label className="sm:col-span-2">Hinweis (optional, bitte keine Diagnosen)<input name="note" maxLength={200} className={input + " w-full"} /></label>
            <div className="sm:col-span-5"><button className={primary}>Beantragen</button> <span className="text-muted">Gezählt werden Arbeitstage (Mo–Fr ohne gesetzliche Feiertage in Österreich).</span></div>
          </form>
        </section>
      )}

      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Wartet auf Ihre Entscheidung</h2>
          <ul className="space-y-2">
            {pending.map((a) => (
              <li key={a.id} className="rounded-xl border border-line bg-surface p-4 text-sm">
                <p><strong>{a.absenceRequest.employee.lastName} {a.absenceRequest.employee.firstName}</strong> · {a.absenceRequest.type.name} · {isoFromDate(a.absenceRequest.startDate)} bis {isoFromDate(a.absenceRequest.endDate)} · {a.absenceRequest.days.toString()} Arbeitstage</p>
                <form action={decide} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="absenceId" value={a.absenceRequestId ?? ""} />
                  <label className="grow">Kommentar (optional)<input name="comment" maxLength={500} className={input + " w-full"} /></label>
                  <button name="decision" value="APPROVE" className={primary}>Genehmigen</button>
                  <button name="decision" value="REJECT" className="rounded-md border border-line px-3 py-1.5">Ablehnen</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">Meine Abwesenheiten</h2>
        <Table rows={mine} showWho={false} canCancel={(r) => r.status === "PENDING" || (r.status === "APPROVED" && isoFromDate(r.startDate) > new Date().toISOString().slice(0, 10))} />
      </section>

      {team.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Mein Team</h2>
          <Table rows={team} showWho canCancel={() => false} />
        </section>
      )}

      {can(ctx, "hr.absence.read_all") && (
        <section className="space-y-2">
          <h2 className="font-medium">Alle Mitarbeiter</h2>
          <Table rows={all} showWho canCancel={(r) => r.status === "PENDING" || r.status === "APPROVED"} />
        </section>
      )}
    </div>
  );
}
