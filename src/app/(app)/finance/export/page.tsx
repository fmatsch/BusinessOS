import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { createAccountingExport, listAccountingExports, previewAccountingExport } from "@/modules/finance/export";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";

async function exportAction(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const upTo = String(fd.get("upTo") ?? "");
  await runAction(`/finance/export${upTo ? `?upTo=${upTo}` : ""}`, () => createAccountingExport(ctx, { upTo, acceptWarnings: fd.get("acceptWarnings") === "on" }));
  revalidatePath("/finance", "layout");
}

const SEV: Record<string, string> = { ERROR: "Fehler", WARNING: "Hinweis", INFO: "Info" };

export default async function ExportPage({ searchParams }: { searchParams: Promise<{ error?: string; upTo?: string }> }) {
  const { error, upTo: upToParam } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "finance.export.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const upTo = /^\d{4}-\d{2}-\d{2}$/.test(upToParam ?? "") ? upToParam! : "";
  const [pv, runs] = await Promise.all([previewAccountingExport(ctx, { upTo }), listAccountingExports(ctx)]);
  const creator = can(ctx, "finance.export.create");
  const hasErrors = pv.checks.some((c) => c.severity === "ERROR");
  const hasWarnings = pv.checks.some((c) => c.severity === "WARNING");
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Export an die Steuerberatung</h1>
        <p className="text-sm text-muted">Format: <strong>{pv.profile.format === "DATEV" ? "DATEV Buchungsstapel" : "BMD BuErf variabel"}</strong> (<Link className="text-accent underline" href="/finance/settings">ändern</Link>). Jeder Beleg wird genau einmal exportiert; Korrekturen erfolgen per Gutschrift.</p>
      </div>
      <ErrorBanner message={error} />

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label>Belege bis Datum (optional)<input type="date" name="upTo" defaultValue={upTo} className={input} /></label>
        <button className="rounded-md border border-line px-3 py-1.5">Vorschau aktualisieren</button>
      </form>

      <section className="space-y-2">
        <h2 className="font-medium">Prüfung</h2>
        {pv.checks.length === 0 ? <p className="text-sm text-muted">Keine Auffälligkeiten.</p> : (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {pv.checks.map((c, i) => <li key={i} className={c.severity === "ERROR" ? "text-red-700 dark:text-red-400" : ""}><strong>{SEV[c.severity]}:</strong> {c.message}</li>)}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Belege im nächsten Lauf (Lauf {pv.nextVersion})</h2>
        {pv.vouchers.length === 0 ? <p className="text-sm text-muted">Nichts zu exportieren.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Beleg</th><th>Art</th><th>Partner</th><th>Datum</th><th className="text-right">Brutto</th><th>Datei</th></tr></thead>
            <tbody className="divide-y divide-line">
              {pv.vouchers.map((v) => (
                <tr key={v.id}><td className="py-2">{v.number}</td><td>{v.type === "SUPPLIER" ? "Eingang" : "Ausgang"}{v.kind === "CREDIT" ? " (Gutschrift)" : ""}</td><td>{v.partner}</td><td>{v.date}</td>
                  <td className="text-right">{formatMoney(v.gross.toString(), ctx.currency)}</td><td>{v.hasFile ? "ja" : "–"}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        {creator && (
          <form action={exportAction} className="flex flex-wrap items-center gap-4 text-sm">
            <input type="hidden" name="upTo" value={upTo} />
            {hasWarnings && <label className="flex items-center gap-2"><input type="checkbox" name="acceptWarnings" /> Hinweise zur Kenntnis genommen</label>}
            <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg" disabled={hasErrors || pv.vouchers.length === 0}>Export erzeugen</button>
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Exportläufe</h2>
        {runs.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Lauf</th><th>Format</th><th>Belege</th><th>Zeilen</th><th>Zeitraum</th><th>Erstellt</th><th>Prüfsumme</th><th>Downloads</th></tr></thead>
            <tbody className="divide-y divide-line">
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">{r.version}</td><td>{r.format}</td><td>{r.voucherCount}</td><td>{r.lineCount}</td>
                  <td>{r.fromDate?.toISOString().slice(0, 10)} bis {r.toDate?.toISOString().slice(0, 10)}</td>
                  <td>{r.createdAt.toLocaleString("de-AT", { timeZone: ctx.timeZone })}</td><td className="font-mono text-xs">{r.contentHash.slice(0, 12)}…</td>
                  <td className="space-x-3">
                    <a className="text-accent underline" href={`/finance/export/download/${r.id}?part=data`} download>Buchungsdatei</a>
                    {r.packageName && <a className="text-accent underline" href={`/finance/export/download/${r.id}?part=package`} download>Belegpaket</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted">Exportläufe sind unveränderlich und mit einer Prüfsumme versehen; jeder Download wird protokolliert.</p>
      </section>
    </div>
  );
}
