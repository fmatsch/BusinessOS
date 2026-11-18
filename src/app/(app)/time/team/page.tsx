import Link from "next/link";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { runOutbox } from "@/modules/events";
import { decideEntryRequest, listTeam } from "@/modules/time/service";
import { ErrorBanner, runAction } from "../../action-helpers";
import { MonthNav, parseMonth, PERIOD_LABEL, ymKey } from "../_shared";

export const dynamic = "force-dynamic";
const TYPE: Record<string, string> = { ADD: "Nachtrag", CORRECT: "Korrektur", DELETE: "Löschung" };

async function decide(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/time/team", () => decideEntryRequest(ctx, { requestId: formData.get("requestId"), decision: formData.get("decision"), comment: formData.get("comment") }));
  after(() => runOutbox());
  revalidatePath("/time/team");
}

export default async function TeamTimePage({ searchParams }: { searchParams: Promise<{ error?: string; month?: string }> }) {
  const { error, month: monthParam } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "time.period.approve") && !can(ctx, "time.entry.read_all")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const { year, month } = parseMonth(monthParam, ctx.timeZone);
  const team = await listTeam(ctx, year, month);
  const tz = ctx.timeZone;
  const t = (d: Date | null) => (d ? d.toLocaleString("de-AT", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";

  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Zeiterfassung: Team</h1>
      <ErrorBanner message={error} />
      <MonthNav base="/time/team" year={year} month={month} />

      {team.pendingRequests.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Offene Zeitanträge</h2>
          <ul className="space-y-2">
            {team.pendingRequests.map((r) => (
              <li key={r.id} className="rounded-xl border border-line bg-surface p-4 text-sm">
                <p><strong>{team.names.get(r.employeeId) ?? "?"}</strong> · {TYPE[r.type]}{r.startAt ? ` · ${t(r.startAt)}–${t(r.endAt)} (Pause ${r.breakMinutes ?? 0} min)` : ""} · „{r.reason}"</p>
                <form action={decide} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="requestId" value={r.id} />
                  <label className="grow">Kommentar (optional)<input name="comment" maxLength={500} className="mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1" /></label>
                  <button name="decision" value="APPROVE" className={primary}>Genehmigen</button>
                  <button name="decision" value="REJECT" className="rounded-md border border-line px-3 py-1.5">Ablehnen</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">Monat {ymKey(year, month)}</h2>
        {team.rows.length === 0 ? <p className="text-sm text-muted">Keine Mitarbeiter in Ihrem Zuständigkeitsbereich.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Mitarbeiter</th><th>Monatsabschluss</th><th>Offene Anträge</th></tr></thead>
            <tbody className="divide-y divide-line">
              {team.rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2"><Link className="text-accent underline" href={`/time/employee/${r.id}?month=${ymKey(year, month)}`}>{r.lastName} {r.firstName}</Link></td>
                  <td>{r.status === "SUBMITTED" ? <strong>{PERIOD_LABEL[r.status]} – wartet auf Freigabe</strong> : PERIOD_LABEL[r.status]}</td>
                  <td>{r.pendingRequests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted">Der Aufruf der Zeitdaten einer Person wird protokolliert.</p>
      </section>
    </div>
  );
}
