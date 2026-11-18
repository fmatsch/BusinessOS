import Link from "next/link";
import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError, ConflictError } from "@/platform/errors";
import { listReports, runReport } from "@/modules/analytics/service";
import { ErrorBanner } from "../action-helpers";

export const dynamic = "force-dynamic";

const nf = new Intl.NumberFormat("de-AT", { maximumFractionDigits: 2 });

/** Balkendiagramm als SVG. Die Tabelle darunter enthält dieselben Werte (für Screenreader und Export). */
function BarChart({ rows, labelKey, valueKey, unit, title }: { rows: Record<string, string>[]; labelKey: string; valueKey: string; unit: string; title: string }) {
  const data = rows.slice(0, 15).map((r) => ({ label: r[labelKey] ?? "", value: Number(r[valueKey] ?? 0) })).filter((d) => Number.isFinite(d.value));
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const rowH = 26, labelW = 190, barW = 380, h = data.length * rowH + 8;
  return (
    <svg role="img" aria-label={`${title}: ${data.map((d) => `${d.label} ${nf.format(d.value)} ${unit}`).join("; ")}`} viewBox={`0 0 ${labelW + barW + 110} ${h}`} className="w-full max-w-3xl">
      {data.map((d, i) => {
        const w = (Math.abs(d.value) / max) * barW;
        const y = i * rowH + 4;
        return (
          <g key={i}>
            <text x={labelW - 8} y={y + 16} textAnchor="end" fontSize="12" fill="currentColor">{d.label.length > 28 ? `${d.label.slice(0, 27)}…` : d.label}</text>
            <rect x={labelW} y={y + 3} width={Math.max(w, 1)} height={rowH - 10} rx="3" fill={d.value < 0 ? "#b91c1c" : "var(--accent, #2563eb)"} />
            <text x={labelW + w + 6} y={y + 16} fontSize="12" fill="currentColor">{nf.format(d.value)} {unit}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ report?: string; year?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireContext();
  let reports;
  try { reports = await listReports(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const year = Number(sp.year) || new Date().getUTCFullYear();
  const current = reports.find((r) => r.id === sp.report) ?? reports[0];
  let result = null, error: string | undefined;
  if (current) {
    try { result = await runReport(ctx, current.id, year); } catch (e) {
      if (e instanceof ConflictError || e instanceof NotFoundError || e instanceof ForbiddenError) error = e.message || "Der Bericht ist nicht verfügbar.";
      else throw e;
    }
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Analysen</h1>
        <p className="text-sm text-muted">Auswertungen über die Module. Sie sehen nur Berichte, für deren Daten Sie berechtigt sind; jeder CSV-Export wird protokolliert. Es sind feste Berichte – keine frei zusammenstellbaren Abfragen.</p>
      </div>
      <ErrorBanner message={error} />
      {reports.length === 0 ? <p className="text-sm text-muted">Für Ihre Berechtigungen gibt es keine Berichte.</p> : (
        <div className="grid gap-6 md:grid-cols-[240px_1fr]">
          <nav aria-label="Berichte"><ul className="space-y-1 text-sm">
            {reports.map((r) => (
              <li key={r.id}><Link href={`/analytics?report=${r.id}&year=${year}`} aria-current={current?.id === r.id ? "page" : undefined} className={current?.id === r.id ? "font-semibold underline" : "text-accent underline"}>{r.title}</Link></li>
            ))}
          </ul></nav>
          {result && current && (
            <section className="space-y-4" aria-label={result.title}>
              <div>
                <h2 className="text-xl font-medium">{result.title}{result.year ? ` ${result.year}` : ""}</h2>
                <p className="text-sm text-muted">{result.description}</p>
              </div>
              <div className="flex flex-wrap items-end gap-4 text-sm">
                {current.usesYear && (
                  <form className="flex items-end gap-2"><input type="hidden" name="report" value={current.id} />
                    <label>Jahr<input name="year" type="number" min={2000} max={2100} defaultValue={year} className="mt-1 block w-24 rounded-md border border-line bg-bg px-2 py-1" /></label>
                    <button className="rounded-md border border-line px-3 py-1.5">Anzeigen</button></form>
                )}
                <a className="rounded-md border border-line px-3 py-1.5" href={`/analytics/export/${current.id}?year=${year}`}>Als CSV herunterladen</a>
              </div>
              {result.note && <p role="status" className="text-sm font-medium">{result.note}</p>}
              {result.chart && <BarChart rows={result.rows} title={result.title} {...result.chart} />}
              {result.rows.length === 0 ? <p className="text-sm text-muted">Keine Daten.</p> : (
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">{result.title}</caption>
                  <thead className="text-muted"><tr>{result.columns.map((c) => <th key={c.key} scope="col" className={`py-2 ${c.numeric ? "text-right" : ""}`}>{c.label}</th>)}</tr></thead>
                  <tbody className="divide-y divide-line">
                    {result.rows.map((r, i) => <tr key={i}>{result.columns.map((c) => <td key={c.key} className={`py-1.5 ${c.numeric ? "text-right" : ""}`}>{c.numeric && r[c.key] !== "" ? nf.format(Number(r[c.key])) : r[c.key]}</td>)}</tr>)}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
