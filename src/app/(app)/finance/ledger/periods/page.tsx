import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { closePeriod, listPeriods, reopenPeriod } from "@/modules/gl/service";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";
const MONTHS = ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

async function close(fd: FormData) { "use server"; const ctx = await requireContext(); const y = Number(fd.get("year")); await runAction(`/finance/ledger/periods?year=${y}`, () => closePeriod(ctx, { year: y, month: Number(fd.get("month")) })); revalidatePath("/finance/ledger/periods"); }
async function reopen(fd: FormData) { "use server"; const ctx = await requireContext(); const y = Number(fd.get("year")); await runAction(`/finance/ledger/periods?year=${y}`, () => reopenPeriod(ctx, { year: y, month: Number(fd.get("month")) }, String(fd.get("reason") ?? ""))); revalidatePath("/finance/ledger/periods"); }

export default async function PeriodsPage({ searchParams }: { searchParams: Promise<{ error?: string; year?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireContext();
  const year = Number(sp.year) || new Date().getUTCFullYear();
  let periods;
  try { periods = await listPeriods(ctx, year); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const closer = can(ctx, "gl.close"), reopener = can(ctx, "gl.reopen");

  return (
    <div className="max-w-3xl space-y-6">
      <div><p className="text-sm"><Link className="text-accent underline" href="/finance/ledger">← Hauptbuch</Link></p><h1 className="text-2xl font-semibold tracking-tight">Perioden {year}</h1>
        <p className="text-sm text-muted">Geschlossene Monate nehmen keine Buchungen mehr an – auch keine automatischen (Rechnung ausstellen, Zahlung vermerken). Wieder öffnen kann nur der Inhaber mit Begründung. <Link className="text-accent underline" href={`/finance/ledger/periods?year=${year - 1}`}>{year - 1}</Link> · <Link className="text-accent underline" href={`/finance/ledger/periods?year=${year + 1}`}>{year + 1}</Link></p></div>
      <ErrorBanner message={sp.error} />
      <table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-2">Monat</th><th>Status</th><th /></tr></thead>
        <tbody className="divide-y divide-line">
          {periods.map((p) => (
            <tr key={p.month}>
              <td className="py-2">{MONTHS[p.month - 1]} {year}</td><td>{p.status === "CLOSED" ? "abgeschlossen" : "offen"}{p.note ? ` (zuletzt geöffnet: ${p.note})` : ""}</td>
              <td>
                {p.status === "OPEN" && closer && <form action={close}><input type="hidden" name="year" value={year} /><input type="hidden" name="month" value={p.month} /><button className="rounded-md border border-line px-2 py-0.5" aria-label={`${MONTHS[p.month - 1]} abschließen`}>Abschließen</button></form>}
                {p.status === "CLOSED" && reopener && <form action={reopen} className="flex items-center gap-1"><input type="hidden" name="year" value={year} /><input type="hidden" name="month" value={p.month} /><input name="reason" required minLength={5} placeholder="Begründung" aria-label={`Begründung ${MONTHS[p.month - 1]}`} className="w-40 rounded-md border border-line bg-bg px-2 py-0.5" /><button className="rounded-md border border-line px-2 py-0.5">Öffnen</button></form>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
