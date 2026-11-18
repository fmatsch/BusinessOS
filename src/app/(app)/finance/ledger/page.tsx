import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createManualEntry, getGlSettings, listEntries, postMissingDocuments, reverseEntry } from "@/modules/gl/service";
import { listAccounts } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/finance/ledger";
const SLOTS = 4;
const SOURCE: Record<string, string> = { MANUAL: "manuell", OPENING: "Eröffnung", CUSTOMER_INVOICE: "Ausgangsrechnung", SUPPLIER_INVOICE: "Eingangsrechnung", CUSTOMER_PAYMENT: "Zahlungseingang", SUPPLIER_PAYMENT: "Zahlungsausgang", REVERSAL: "Storno", DEPRECIATION: "Abschreibung", PAYROLL: "Lohn" };

async function entry(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const lines = Array.from({ length: SLOTS }, (_, i) => ({ accountId: String(fd.get(`acc${i}`) ?? ""), debit: String(fd.get(`d${i}`) ?? "").replace(",", "."), credit: String(fd.get(`c${i}`) ?? "").replace(",", ".") })).filter((l) => l.accountId !== "");
  await runAction(BACK, () => createManualEntry(ctx, { date: fd.get("date"), text: fd.get("text"), opening: fd.get("opening") === "on", lines }));
  revalidatePath(BACK);
}
async function reverse(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => reverseEntry(ctx, String(fd.get("id")), String(fd.get("reason") ?? ""))); revalidatePath(BACK); }
async function backfill() {
  "use server";
  const ctx = await requireContext();
  const r = await runAction(BACK, () => postMissingDocuments(ctx));
  revalidatePath(BACK);
  redirect(`${BACK}?posted=${r.posted}${r.failed.length ? `&error=${encodeURIComponent(r.failed.slice(0, 3).map((f) => f.error).join(" · "))}` : ""}`);
}

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ error?: string; posted?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireContext();
  let settings, entries, accounts;
  try { [settings, entries, accounts] = await Promise.all([getGlSettings(ctx), listEntries(ctx, { take: 60 }), can(ctx, "gl.post") ? listAccounts(ctx) : Promise.resolve([])]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const names = new Map(accounts.map((a) => [a.id, `${a.number} ${a.name}`]));
  const poster = can(ctx, "gl.post");
  const today = new Date().toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Hauptbuch</h1>
        <p className="text-sm text-muted">Doppelte Buchführung: Rechnungen und Zahlungen werden ab dem Startdatum automatisch gebucht; Buchungssätze sind unveränderlich (Korrektur per Storno) und immer ausgeglichen. <Link className="text-accent underline" href="/finance/ledger/reports">Auswertungen</Link> · <Link className="text-accent underline" href="/finance/ledger/periods">Perioden</Link> · <Link className="text-accent underline" href="/finance/ledger/assets">Anlagen</Link> · <Link className="text-accent underline" href="/finance/ledger/setup">Einrichtung</Link></p>
      </div>
      <ErrorBanner message={sp.error} />
      {sp.posted !== undefined && <p role="status" className="text-sm">{sp.posted} Buchungen nachgetragen.</p>}
      {!settings ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-sm">Das Hauptbuch ist noch nicht eingeschaltet. Legen Sie unter <Link className="text-accent underline" href="/finance/ledger/setup">Einrichtung</Link> das Startdatum und das Bankkonto fest, ordnen Sie die Konten ein und hinterlegen Sie die Steuerkonten.</p>
      ) : (
        <>
          <p className="text-sm text-muted">Start: {settings.startDate.toISOString().slice(0, 10)}{can(ctx, "gl.settings") && <> · <form action={backfill} className="inline"><button className="text-accent underline">Fehlende Belege nachbuchen</button></form></>}</p>
          {poster && (
            <form action={entry} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Manuelle Buchung">
              <h2 className="font-medium">Manuelle Buchung</h2>
              <div className="grid gap-3 sm:grid-cols-4">
                <label>Datum<input type="date" name="date" defaultValue={today} required className={input} /></label>
                <label className="sm:col-span-2">Buchungstext<input name="text" required maxLength={200} className={input} /></label>
                <label className="flex items-end gap-2"><input type="checkbox" name="opening" /> Eröffnungsbuchung</label>
              </div>
              {Array.from({ length: SLOTS }, (_, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-4">
                  <select name={`acc${i}`} aria-label={`Konto ${i + 1}`} className={input + " sm:col-span-2"}><option value="">Konto …</option>{accounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select>
                  <input name={`d${i}`} inputMode="decimal" placeholder="Soll" aria-label={`Soll ${i + 1}`} className={input} />
                  <input name={`c${i}`} inputMode="decimal" placeholder="Haben" aria-label={`Haben ${i + 1}`} className={input} />
                </div>
              ))}
              <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Buchen</button>
            </form>
          )}
          {entries.length === 0 ? <p className="text-sm text-muted">Noch keine Buchungen.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2">Nr.</th><th>Datum</th><th>Text</th><th>Art</th><th>Konto</th><th className="text-right">Soll</th><th className="text-right">Haben</th><th /></tr></thead>
              <tbody className="divide-y divide-line align-top">
                {entries.map((e) => e.lines.map((l, i) => (
                  <tr key={l.id}>
                    <td className="py-1.5">{i === 0 ? e.number : ""}</td><td>{i === 0 ? e.entryDate.toISOString().slice(0, 10) : ""}</td><td>{i === 0 ? e.text : ""}</td><td>{i === 0 ? `${SOURCE[e.source] ?? e.source}${e.reversedBy ? ` (storniert durch ${e.reversedBy.number})` : ""}` : ""}</td>
                    <td>{names.get(l.accountId) ?? l.accountId.slice(0, 6)}</td>
                    <td className="text-right">{l.debit.gt(0) ? formatMoney(l.debit.toString()) : ""}</td><td className="text-right">{l.credit.gt(0) ? formatMoney(l.credit.toString()) : ""}</td>
                    <td>{i === 0 && poster && e.source !== "REVERSAL" && !e.reversedBy && (
                      <form action={reverse} className="flex items-center gap-1"><input type="hidden" name="id" value={e.id} /><input name="reason" required minLength={3} placeholder="Grund" aria-label={`Grund für Storno ${e.number}`} className="w-24 rounded-md border border-line bg-bg px-2 py-0.5" /><button className="rounded-md border border-line px-2 py-0.5">Storno</button></form>
                    )}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
