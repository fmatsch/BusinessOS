import { revalidatePath } from "next/cache";
import { listSuppliers } from "@/modules/procurement/service";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import {
  createAccount, createCustomer, createTaxCode, getAccountingProfile, getIssuerProfile, importAccounts, listAccounts, listCustomers, listTaxCodes, setAccountingProfile, setIssuerProfile,
  setCustomerAccounts, setCustomerEinvoiceEndpoint, setSupplierAccounts, updateTaxMapping,
} from "@/modules/finance/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/finance/settings";

async function addAccount(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createAccount(ctx, { number: fd.get("number"), name: fd.get("name"), type: fd.get("type") })); revalidatePath(BACK); }
async function importAction(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => importAccounts(ctx, String(fd.get("text") ?? ""))); revalidatePath(BACK); }
async function addTax(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createTaxCode(ctx, { key: fd.get("key"), name: fd.get("name"), rate: fd.get("rate"), direction: fd.get("direction"), bmdCode: fd.get("bmdCode"), datevKey: fd.get("datevKey") })); revalidatePath(BACK); }
async function mapTax(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => updateTaxMapping(ctx, String(fd.get("id")), { bmdCode: fd.get("bmdCode"), datevKey: fd.get("datevKey") })); revalidatePath(BACK); }
async function supplierAcc(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setSupplierAccounts(ctx, String(fd.get("id")), { uid: fd.get("uid"), accountId: fd.get("accountId"), lineAccountId: fd.get("lineAccountId") })); revalidatePath(BACK); }
async function customerAcc(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, async () => { await setCustomerAccounts(ctx, String(fd.get("id")), { uid: fd.get("uid"), accountId: fd.get("accountId"), lineAccountId: fd.get("lineAccountId") }); await setCustomerEinvoiceEndpoint(ctx, String(fd.get("id")), String(fd.get("endpoint") ?? "")); }); revalidatePath(BACK); }
async function addCustomer(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createCustomer(ctx, { number: fd.get("number"), name: fd.get("name"), street: fd.get("street"), zip: fd.get("zip"), city: fd.get("city"), uid: fd.get("uid"), paymentTermsDays: fd.get("paymentTermsDays") || 14 })); revalidatePath(BACK); }
async function saveProfile(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => setAccountingProfile(ctx, {
    format: fd.get("format"), advisorNumber: fd.get("advisorNumber"), clientNumber: fd.get("clientNumber"), accountLength: fd.get("accountLength"), fiscalYearStartMonth: fd.get("fiscalYearStartMonth"),
    symbolIn: String(fd.get("symbolIn") ?? "").toUpperCase(), symbolOut: String(fd.get("symbolOut") ?? "").toUpperCase(), dictationCode: fd.get("dictationCode") ?? "", includeFiles: fd.get("includeFiles") === "on", matchTolerancePercent: fd.get("matchTolerancePercent") || "2", matchToleranceAmount: fd.get("matchToleranceAmount") || "5",
  }));
  revalidatePath(BACK);
}

async function saveIssuer(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const f = (k: string) => fd.get(k);
  await runAction(BACK, () => setIssuerProfile(ctx, { legalName: f("legalName"), street: f("street"), zip: f("zip"), city: f("city"), country: f("country") || "AT", uid: f("uid"), companyRegister: f("companyRegister"), iban: f("iban"), bic: f("bic"), bankName: f("bankName"), email: f("email"), phone: f("phone") }));
  revalidatePath(BACK);
}

const TYPE: Record<string, string> = { GL: "Sachkonto", VENDOR: "Kreditor", CUSTOMER: "Debitor" };

export default async function FinanceSettings({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "finance.master.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const writer = can(ctx, "finance.master.write");
  const [accounts, taxCodes, customers, suppliers, profile, issuer] = await Promise.all([
    listAccounts(ctx), listTaxCodes(ctx), listCustomers(ctx),
    can(ctx, "procurement.supplier.read") ? listSuppliers(ctx) : Promise.resolve([]),
    getAccountingProfile(ctx).catch(() => null),
    getIssuerProfile(ctx),
  ]);
  const activeSuppliers = suppliers.filter((s) => s.active);
  const gl = accounts.filter((a) => a.type === "GL" && a.active), vendors = accounts.filter((a) => a.type === "VENDOR" && a.active), debtors = accounts.filter((a) => a.type === "CUSTOMER" && a.active);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const sel = (id: string | null | undefined, list: typeof accounts, name: string, label: string) => (
    <label>{label}<select name={name} defaultValue={id ?? ""} className={input}><option value="">–</option>{list.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>
  );

  return (
    <div className="max-w-5xl space-y-10">
      <h1 className="text-2xl font-semibold tracking-tight">Finanzen: Einstellungen</h1>
      <ErrorBanner message={error} />

      <section className="space-y-2" aria-label="Aussteller">
        <h2 className="font-medium">Aussteller (Briefkopf der Rechnungen)</h2>
        <p className="text-sm text-muted">Erscheint auf dem PDF der Ausgangsrechnungen. Beim Ausstellen wird der aktuelle Stand am Beleg gespeichert; spätere Änderungen betreffen nur neue Rechnungen. Welche Angaben auf einer Rechnung Pflicht sind (z. B. Anschrift und UID des Ausstellers), regelt das Umsatzsteuergesetz; bitte mit der Steuerberatung abstimmen.</p>
        {writer ? (
          <form action={saveIssuer} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
            <label className="sm:col-span-3">Firmenname<input name="legalName" required maxLength={120} defaultValue={issuer?.legalName ?? ""} className={input + " w-full"} /></label>
            <label className="sm:col-span-3">Straße<input name="street" maxLength={120} defaultValue={issuer?.street ?? ""} className={input + " w-full"} /></label>
            <label>PLZ<input name="zip" maxLength={12} defaultValue={issuer?.zip ?? ""} className={input} /></label>
            <label className="sm:col-span-2">Ort<input name="city" maxLength={80} defaultValue={issuer?.city ?? ""} className={input + " w-full"} /></label>
            <label>Land (2 Buchstaben)<input name="country" maxLength={2} defaultValue={issuer?.country ?? "AT"} className={input} /></label>
            <label>UID<input name="uid" maxLength={20} defaultValue={issuer?.uid ?? ""} className={input} /></label>
            <label className="sm:col-span-3">Firmenbuch / Rechtsform<input name="companyRegister" maxLength={120} defaultValue={issuer?.companyRegister ?? ""} className={input + " w-full"} placeholder="FN 123456a, Handelsgericht Wien" /></label>
            <label className="sm:col-span-3">IBAN<input name="iban" maxLength={40} defaultValue={issuer?.iban ?? ""} className={input + " w-full"} /></label>
            <label>BIC<input name="bic" maxLength={11} defaultValue={issuer?.bic ?? ""} className={input} /></label>
            <label className="sm:col-span-2">Bank<input name="bankName" maxLength={80} defaultValue={issuer?.bankName ?? ""} className={input + " w-full"} /></label>
            <label className="sm:col-span-2">E-Mail<input name="email" maxLength={120} defaultValue={issuer?.email ?? ""} className={input + " w-full"} /></label>
            <label>Telefon<input name="phone" maxLength={40} defaultValue={issuer?.phone ?? ""} className={input} /></label>
            <div className="sm:col-span-6"><button className={primary}>Aussteller speichern</button></div>
          </form>
        ) : <p className="text-sm">{issuer ? `${issuer.legalName}${issuer.city ? `, ${issuer.city}` : ""}` : "Noch nicht hinterlegt."}</p>}
      </section>

      {profile && (
        <section className="space-y-2">
          <h2 className="font-medium">Format der Steuerberatung</h2>
          <p className="text-sm text-muted">
            DATEV (Buchungsstapel, Format 700/13) und BMD (BuErf variabel) sind nach den veröffentlichten Formatbeschreibungen umgesetzt, aber <strong>nicht gegen ein echtes System getestet</strong>.
            Bitte vor dem ersten Einsatz einen Testimport mit der Steuerberatung machen; Steuerschlüssel und Kontenrahmen gibt die Steuerberatung vor.
          </p>
          {writer ? (
            <form action={saveProfile} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4">
              <label>Format<select name="format" defaultValue={profile.format} className={input}><option value="BMD">BMD (BuErf variabel)</option><option value="DATEV">DATEV (Buchungsstapel)</option></select></label>
              <label>DATEV: Beraternummer<input name="advisorNumber" defaultValue={profile.advisorNumber ?? ""} maxLength={7} className={input} /></label>
              <label>DATEV: Mandantennummer<input name="clientNumber" defaultValue={profile.clientNumber ?? ""} maxLength={5} className={input} /></label>
              <label>DATEV: Diktatkürzel<input name="dictationCode" defaultValue={profile.dictationCode} maxLength={2} className={input} /></label>
              <label>Stellen der Sachkonten<input name="accountLength" type="number" min={4} max={8} defaultValue={profile.accountLength} className={input} /></label>
              <label>Wirtschaftsjahr beginnt im Monat<input name="fiscalYearStartMonth" type="number" min={1} max={12} defaultValue={profile.fiscalYearStartMonth} className={input} /></label>
              <label>BMD: Symbol Eingang<input name="symbolIn" defaultValue={profile.symbolIn} maxLength={3} className={input} /></label>
              <label>BMD: Symbol Ausgang<input name="symbolOut" defaultValue={profile.symbolOut} maxLength={3} className={input} /></label>
              <label>Abgleich-Toleranz (% der Rechnung)<input name="matchTolerancePercent" inputMode="decimal" defaultValue={profile.matchTolerancePercent.toString()} className={input} /></label>
              <label>oder mindestens (Betrag)<input name="matchToleranceAmount" inputMode="decimal" defaultValue={profile.matchToleranceAmount.toString()} className={input} /></label>
              <p className="text-xs text-muted sm:col-span-2">Beim Freigeben einer Rechnung mit Bestellbezug gilt die größere der beiden Toleranzen.</p>
              <label className="flex items-center gap-2 sm:col-span-4"><input type="checkbox" name="includeFiles" defaultChecked={profile.includeFiles} /> Belegdateien als Paket (ZIP) mitliefern</label>
              <div className="sm:col-span-4"><button className={primary}>Profil speichern</button></div>
            </form>
          ) : <p className="text-sm">Format: {profile.format}</p>}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">Steuerkennzeichen</h2>
        {writer && (
          <form action={addTax} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
            <label>Schlüssel<input name="key" required maxLength={20} className={input} /></label>
            <label className="sm:col-span-2">Bezeichnung<input name="name" required maxLength={80} className={input + " w-full"} /></label>
            <label>Satz (%)<input name="rate" required inputMode="decimal" className={input} /></label>
            <label>Art<select name="direction" className={input}><option value="INPUT">Vorsteuer</option><option value="OUTPUT">Umsatzsteuer</option></select></label>
            <label>BMD-Steuercode<input name="bmdCode" maxLength={3} className={input} /></label>
            <label>DATEV-BU-Schlüssel<input name="datevKey" maxLength={4} className={input} /></label>
            <div className="sm:col-span-6"><button className={primary}>Steuerkennzeichen anlegen</button></div>
          </form>
        )}
        {taxCodes.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Schlüssel</th><th>Bezeichnung</th><th>Satz</th><th>Art</th><th>BMD-Steuercode</th><th>DATEV-BU</th>{writer && <th />}</tr></thead>
            <tbody className="divide-y divide-line">
              {taxCodes.map((t) => (
                <tr key={t.id}>
                  <td className="py-2">{t.key}</td><td>{t.name}</td><td>{t.rate.toString()} %</td><td>{t.direction === "INPUT" ? "Vorsteuer" : "Umsatzsteuer"}</td>
                  {writer ? (
                    <td colSpan={3}>
                      <form action={mapTax} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={t.id} />
                        <input name="bmdCode" defaultValue={t.bmdCode ?? ""} aria-label={`BMD-Steuercode für ${t.key}`} maxLength={3} className="w-16 rounded-md border border-line bg-bg px-2 py-1" />
                        <input name="datevKey" defaultValue={t.datevKey ?? ""} aria-label={`DATEV-BU-Schlüssel für ${t.key}`} maxLength={4} className="w-16 rounded-md border border-line bg-bg px-2 py-1" />
                        <button className="rounded-md border border-line px-2 py-1">Zuordnung speichern</button>
                      </form>
                    </td>
                  ) : <><td>{t.bmdCode ?? "–"}</td><td>{t.datevKey ?? "–"}</td></>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Kontenplan</h2>
        <p className="text-sm text-muted">Die Konten kommen von der Steuerberatung. Import: eine Zeile je Konto, „Nummer;Bezeichnung" oder „Nummer;Bezeichnung;Art" (GL, VENDOR, CUSTOMER). Fehlerhafte Zeilen brechen den ganzen Import ab.</p>
        {writer && (
          <div className="grid gap-4 sm:grid-cols-2">
            <form action={importAction} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
              <label>Kontenliste einfügen<textarea name="text" rows={5} required className={input + " w-full font-mono"} placeholder={"4000;Erlöse 20 %\n7000;Aufwand Material\n33001;Kreditor Müller;VENDOR"} /></label>
              <button className={primary}>Importieren</button>
            </form>
            <form action={addAccount} className="grid grid-cols-2 gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
              <label>Nummer<input name="number" required maxLength={9} className={input} /></label>
              <label>Art<select name="type" className={input}><option value="GL">Sachkonto</option><option value="VENDOR">Kreditor</option><option value="CUSTOMER">Debitor</option></select></label>
              <label className="col-span-2">Bezeichnung<input name="name" required maxLength={120} className={input + " w-full"} /></label>
              <div className="col-span-2"><button className={primary}>Konto anlegen</button></div>
            </form>
          </div>
        )}
        {accounts.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Konto</th><th>Bezeichnung</th><th>Art</th></tr></thead>
            <tbody className="divide-y divide-line">{accounts.map((a) => <tr key={a.id}><td className="py-2">{a.number}</td><td>{a.name}</td><td>{TYPE[a.type]}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Lieferanten: Kreditorenkonto und Aufwandskonto</h2>
        {activeSuppliers.length === 0 ? <p className="text-sm text-muted">Noch keine Lieferanten (Beschaffung → Lieferanten).</p> : (
          <ul className="space-y-2">
            {activeSuppliers.map((s) => (
              <li key={s.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
                <form action={supplierAcc} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="id" value={s.id} />
                  <strong className="min-w-40">{s.number} {s.name}</strong>
                  {sel(s.payableAccountId, vendors, "accountId", "Kreditor")}
                  {sel(s.expenseAccountId, gl, "lineAccountId", "Standard-Aufwandskonto")}
                  <label>UID<input name="uid" defaultValue={s.uid ?? ""} maxLength={20} className={input} /></label>
                  {writer && <button className="rounded-md border border-line px-2 py-1">Speichern</button>}
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Kunden</h2>
        {writer && (
          <form action={addCustomer} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
            <label>Nummer<input name="number" required maxLength={20} className={input} /></label>
            <label className="sm:col-span-2">Name<input name="name" required maxLength={120} className={input + " w-full"} /></label>
            <label>Straße<input name="street" maxLength={120} className={input} /></label>
            <label>PLZ<input name="zip" maxLength={12} className={input} /></label>
            <label>Ort<input name="city" maxLength={80} className={input} /></label>
            <label>UID<input name="uid" maxLength={20} className={input} /></label>
            <label>Zahlungsziel (Tage)<input name="paymentTermsDays" type="number" min={0} defaultValue={14} className={input} /></label>
            <div className="sm:col-span-6"><button className={primary}>Kunde anlegen</button></div>
          </form>
        )}
        {customers.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
          <ul className="space-y-2">
            {customers.map((c) => (
              <li key={c.id} className="rounded-xl border border-line bg-surface p-3 text-sm">
                <form action={customerAcc} className="flex flex-wrap items-end gap-3">
                  <input type="hidden" name="id" value={c.id} />
                  <strong className="min-w-40">{c.number} {c.name}</strong>
                  {sel(c.receivableAccountId, debtors, "accountId", "Debitor")}
                  {sel(c.revenueAccountId, gl, "lineAccountId", "Standard-Erlöskonto")}
                  <label>UID<input name="uid" defaultValue={c.uid ?? ""} maxLength={20} className={input} /></label>
                  <label>E-Rechnung-Adresse<input name="endpoint" defaultValue={c.einvoiceEndpoint ?? ""} maxLength={120} placeholder="E-Mail oder 9915:Kennung" className={input} /></label>
                  {writer && <button className="rounded-md border border-line px-2 py-1">Speichern</button>}
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
