import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { activateGl, getGlSettings } from "@/modules/gl/service";
import { KIND_LABEL, kindOf, type AccountKind } from "@/modules/gl/rules";
import { listAccounts, listTaxCodes, setAccountKind, setTaxGlMapping } from "@/modules/finance/service";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/finance/ledger/setup";

async function activate(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => activateGl(ctx, { startDate: fd.get("startDate"), bankAccountId: fd.get("bankAccountId") })); revalidatePath(BACK); }
async function kind(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setAccountKind(ctx, String(fd.get("id")), String(fd.get("kind") ?? "") || null)); revalidatePath(BACK); }
async function taxMap(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setTaxGlMapping(ctx, String(fd.get("id")), { vatAccountId: String(fd.get("vatAccountId") ?? "") || null, uvaBaseCode: String(fd.get("uvaBaseCode") ?? ""), uvaTaxCode: String(fd.get("uvaTaxCode") ?? "") })); revalidatePath(BACK); }

export default async function LedgerSetup({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let settings, accounts, taxCodes;
  try { [settings, accounts, taxCodes] = await Promise.all([getGlSettings(ctx), listAccounts(ctx), listTaxCodes(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "gl.settings"), master = can(ctx, "finance.master.write");
  const gl = accounts.filter((a) => a.type === "GL" && a.active);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const year = new Date().getUTCFullYear();

  return (
    <div className="max-w-5xl space-y-8">
      <div><p className="text-sm"><Link className="text-accent underline" href="/finance/ledger">← Hauptbuch</Link></p><h1 className="text-2xl font-semibold tracking-tight">Hauptbuch: Einrichtung</h1></div>
      <ErrorBanner message={error} />

      <section className="space-y-2" aria-label="Einschalten">
        <h2 className="font-medium">Einschalten</h2>
        <p className="text-sm text-muted">Ab dem Startdatum werden ausgestellte und freigegebene Belege sowie Zahlungsvermerke automatisch gebucht. Das Startdatum kann später nicht geändert werden; frühere Stände tragen Sie als Eröffnungsbuchung ein.</p>
        {manage ? (
          <form action={activate} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
            <label>Startdatum<input type="date" name="startDate" required defaultValue={settings ? settings.startDate.toISOString().slice(0, 10) : `${year}-01-01`} readOnly={!!settings} className={input} /></label>
            <label>Bankkonto<select name="bankAccountId" defaultValue={settings?.bankAccountId ?? ""} className={input}><option value="">–</option>{gl.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>
            <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">{settings ? "Bankkonto speichern" : "Hauptbuch einschalten"}</button>
          </form>
        ) : <p className="text-sm">{settings ? `Eingeschaltet seit ${settings.startDate.toISOString().slice(0, 10)}` : "Nicht eingeschaltet."}</p>}
      </section>

      <section className="space-y-2" aria-label="Konten einordnen">
        <h2 className="font-medium">Konten für Bilanz und GuV einordnen</h2>
        <p className="text-sm text-muted">Sachkonten brauchen eine Einordnung (Aktiva, Passiva, Eigenkapital, Ertrag, Aufwand), sonst erscheinen sie nicht in Bilanz und GuV. Debitoren zählen zu den Aktiva, Kreditoren zu den Passiva.</p>
        {gl.length === 0 ? <p className="text-sm text-muted">Noch keine Sachkonten.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Konto</th><th>Einordnung</th></tr></thead>
            <tbody className="divide-y divide-line">
              {gl.map((a) => (
                <tr key={a.id}><td className="py-1.5">{a.number} {a.name}</td>
                  <td>{master ? (
                    <form action={kind} className="flex items-center gap-2"><input type="hidden" name="id" value={a.id} />
                      <select name="kind" defaultValue={a.kind ?? ""} aria-label={`Einordnung ${a.number}`} className="rounded-md border border-line bg-bg px-2 py-0.5"><option value="">nicht eingeordnet</option>{(Object.keys(KIND_LABEL) as AccountKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
                      <button className="rounded-md border border-line px-2 py-0.5">Speichern</button></form>
                  ) : (kindOf(a) ? KIND_LABEL[kindOf(a)!] : "–")}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2" aria-label="Steuerkonten">
        <h2 className="font-medium">Steuerkonten und Kennzahlen der Voranmeldung</h2>
        <p className="text-sm text-muted">Je Steuerkennzeichen mit Satz über 0: das Konto der Umsatz- bzw. Vorsteuer. Die Kennzahlen (z. B. 022 Bemessungsgrundlage, 029 Steuer) nennt die Steuerberatung.</p>
        {taxCodes.length === 0 ? <p className="text-sm text-muted">Noch keine Steuerkennzeichen.</p> : (
          <ul className="space-y-2">
            {taxCodes.map((t) => (
              <li key={t.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
                <form action={taxMap} className="flex flex-wrap items-end gap-3"><input type="hidden" name="id" value={t.id} />
                  <strong className="min-w-40">{t.key} · {t.rate.toString()} % · {t.direction === "OUTPUT" ? "Umsatzsteuer" : "Vorsteuer"}</strong>
                  <label>Steuerkonto<select name="vatAccountId" defaultValue={t.vatAccountId ?? ""} disabled={!master} className={input}><option value="">–</option>{gl.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>
                  <label>KZ Bemessungsgrundlage<input name="uvaBaseCode" defaultValue={t.uvaBaseCode ?? ""} maxLength={3} disabled={!master} className={input + " w-20"} /></label>
                  <label>KZ Steuer<input name="uvaTaxCode" defaultValue={t.uvaTaxCode ?? ""} maxLength={3} disabled={!master} className={input + " w-20"} /></label>
                  {master && <button className="rounded-md border border-line px-2 py-1">Speichern</button>}
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
