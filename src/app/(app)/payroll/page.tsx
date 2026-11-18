import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { createExport, getProfile, listExports, previewExport, setProfile } from "@/modules/payroll/service";
import { formatQuantity } from "@/modules/payroll/csv";
import { WAGE_LABEL, WAGE_TYPES } from "@/modules/payroll/lines";
import { ErrorBanner, runAction } from "../action-helpers";
import { MonthNav, shiftMonth, ymKey } from "../time/_shared";

export const dynamic = "force-dynamic";

function monthOf(raw: string | undefined) {
  const m = /^(\d{4})-(\d{2})$/.exec(raw ?? "");
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  const p = shiftMonth(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, -1); // Standard: Vormonat
  return p;
}
const back = (fd: FormData) => `/payroll?month=${fd.get("year")}-${String(fd.get("month")).padStart(2, "0")}`;

async function exportAction(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(back(formData), () => createExport(ctx, { year: formData.get("year"), month: formData.get("month"), acceptIncomplete: formData.get("acceptIncomplete") === "on" }));
  revalidatePath("/payroll");
}
async function profileAction(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const codes = Object.fromEntries(WAGE_TYPES.map((w) => [w, String(formData.get(`code_${w}`) ?? "")]));
  await runAction("/payroll", () => setProfile(ctx, {
    delimiter: formData.get("delimiter"), decimalSeparator: formData.get("decimalSeparator"), encoding: formData.get("encoding"), unit: formData.get("unit"),
    includeHeader: formData.get("includeHeader") === "on", includeSurcharge: formData.get("includeSurcharge") === "on", codes,
  }));
  revalidatePath("/payroll");
}

const SEV: Record<string, string> = { ERROR: "Fehler", WARNING: "Hinweis", INFO: "Info" };

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ error?: string; month?: string }> }) {
  const { error, month: monthParam } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "payroll.export.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const { year, month } = monthOf(monthParam);
  const [pv, runs, profile] = await Promise.all([previewExport(ctx, { year, month }), listExports(ctx), getProfile(ctx)]);
  const creator = can(ctx, "payroll.export.create");
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const blocked = pv.checks.some((c) => c.severity === "ERROR") || pv.employees.length === 0;

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Lohn-Export</h1>
        <p className="text-sm text-muted">Übergibt erfasste Zeiten und Abwesenheiten freigegebener Monate an die Lohnverrechnung. Es werden keine Löhne, Steuern oder Abgaben berechnet.</p>
      </div>
      <ErrorBanner message={error} />
      <MonthNav base="/payroll" year={year} month={month} />

      <section className="space-y-2">
        <h2 className="font-medium">Prüfung {ymKey(year, month)}</h2>
        {pv.checks.length === 0 ? <p className="text-sm text-muted">Keine Auffälligkeiten.</p> : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {pv.checks.map((c, i) => <li key={i} className={c.severity === "ERROR" ? "text-red-700 dark:text-red-400" : ""}><strong>{SEV[c.severity]}:</strong> {c.message}</li>)}
          </ul>
        )}
        {pv.incomplete.length > 0 && (
          <div className="rounded-xl border border-line bg-surface p-4 text-sm">
            <p className="font-medium">{pv.incomplete.length} Beschäftigte noch nicht vollständig</p>
            <ul className="mt-1 list-disc pl-5">{pv.incomplete.map((i) => <li key={i.employeeId}>{i.number} {i.name}: {i.reason}</li>)}</ul>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Vorschau: {pv.nextVersion === 1 ? "Erstexport" : `Nachtrag ${pv.nextVersion - 1}`}</h2>
        {pv.employees.length === 0 ? <p className="text-sm text-muted">Nichts zu exportieren.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Personalnr.</th><th>Name</th><th>Lohnart</th><th className="text-right">Menge</th><th>Zuschlag</th></tr></thead>
            <tbody className="divide-y divide-line">
              {pv.employees.flatMap((e) => e.lines.map((l) => {
                const q = formatQuantity(l.quantity, l.wageType, profile.unit, profile.decimalSeparator);
                return <tr key={`${e.employeeId}-${l.wageType}`}><td className="py-2">{e.number}</td><td>{e.name}</td><td>{WAGE_LABEL[l.wageType]} ({profile.codes[l.wageType] || "keine Lohnart"})</td><td className="text-right">{q.text} {q.unitLabel}</td><td>{l.percent !== null ? `${l.percent} %` : ""}</td></tr>;
              }))}
            </tbody>
          </table>
        )}
        {creator && (
          <form action={exportAction} className="flex flex-wrap items-center gap-4 text-sm">
            <input type="hidden" name="year" value={year} /><input type="hidden" name="month" value={month} />
            {pv.incomplete.length > 0 && <label className="flex items-center gap-2"><input type="checkbox" name="acceptIncomplete" /> Unvollständige Beschäftigte jetzt auslassen (sie folgen später als Nachtrag)</label>}
            <button className={primary} disabled={blocked}>Export erzeugen</button>
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Exportläufe</h2>
        {runs.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Monat</th><th>Lauf</th><th>Zeilen</th><th>Erstellt</th><th>Prüfsumme</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">{ymKey(r.year, r.month)}</td><td>{r.version === 1 ? "Erstexport" : `Nachtrag ${r.version - 1}`}</td><td>{r.lineCount}</td>
                  <td>{r.createdAt.toLocaleString("de-AT", { timeZone: ctx.timeZone })}</td><td className="font-mono text-xs">{r.contentHash.slice(0, 12)}…</td>
                  <td><a className="text-accent underline" href={`/payroll/download/${r.id}`} download>Herunterladen</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted">Exportläufe sind unveränderlich. Änderungen an einem bereits exportierten Monat erscheinen im nächsten Lauf als Differenz (Nachtrag), auch mit negativen Mengen.</p>
      </section>

      {can(ctx, "payroll.profile.manage") && (
        <section className="space-y-2">
          <h2 className="font-medium">Format und Lohnarten</h2>
          <p className="text-sm text-muted">Die Datei ist zeilenbasiert (eine Zeile je Mitarbeiter und Lohnart) und wird über diese Zuordnung an Ihr Lohnprogramm angepasst. Ein vorgefertigtes Format für ein bestimmtes Programm gibt es nicht.</p>
          <form action={profileAction} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4">
            <label>Trennzeichen<select name="delimiter" defaultValue={profile.delimiter} className={input}><option value=";">Semikolon (;)</option><option value=",">Komma (,)</option><option value={"\t"}>Tabulator</option><option value="|">Senkrechtstrich (|)</option></select></label>
            <label>Dezimalzeichen<select name="decimalSeparator" defaultValue={profile.decimalSeparator} className={input}><option value=",">Komma</option><option value=".">Punkt</option></select></label>
            <label>Zeichensatz<select name="encoding" defaultValue={profile.encoding} className={input}><option value="utf8-bom">UTF-8 mit BOM</option><option value="utf8">UTF-8</option><option value="latin1">Latin-1 (ISO-8859-1)</option></select></label>
            <label>Einheit Arbeitszeit<select name="unit" defaultValue={profile.unit} className={input}><option value="HOURS">Dezimalstunden</option><option value="MINUTES">Minuten</option></select></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeHeader" defaultChecked={profile.includeHeader} /> Kopfzeile</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeSurcharge" defaultChecked={profile.includeSurcharge} /> Spalte Zuschlag %</label>
            <div className="sm:col-span-4 grid gap-3 sm:grid-cols-3">
              {WAGE_TYPES.map((w) => <label key={w}>Lohnart für {WAGE_LABEL[w]}<input name={`code_${w}`} defaultValue={profile.codes[w] ?? ""} maxLength={20} className={input + " w-full"} /></label>)}
            </div>
            <div className="sm:col-span-4"><button className={primary}>Profil speichern</button></div>
          </form>
        </section>
      )}
    </div>
  );
}
