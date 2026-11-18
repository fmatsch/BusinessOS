/* Synthetisches Demo-Szenario für Screenshots (läuft NACH prisma/seed.ts, gegen eine eigene Datenbank).
 * Alle Namen, Firmen, UIDs und Nummern sind erfunden. Aufruf: DATABASE_URL=… npx tsx scripts/demo-scenario.ts */
import { db } from "../src/lib/db";
import type { Ctx } from "../src/platform/authz/authorize";
import { SYSTEM_ROLES, type Permission } from "../src/platform/authz/permissions";
import { runOutbox } from "../src/modules/events";
import { createDepartment, createCostCenter, listCostCenters } from "../src/modules/masterdata/service";
import { setBudget } from "../src/modules/budget/service";
import { createSupplier, createRequest, decideRequest, createOrder } from "../src/modules/procurement/service";
import { createEmployee, addLeaveEntry, requestAbsence, decideAbsence, listEmployees } from "../src/modules/hr/service";
import { addShift, assignEmployee, createQualification, createRoster, createSite, createTemplate, publishRoster, setEmployeeQualification } from "../src/modules/roster/service";
import { addEntryDirect, approvePeriod, setPayCodeRules, submitPeriod, clockIn } from "../src/modules/time/service";
import { createExport as createPayrollExport, setProfile as setPayrollProfile } from "../src/modules/payroll/service";
import {
  approveSupplierInvoice, createAccount, createCustomer, createCustomerInvoice, createSupplierInvoice, createTaxCode, importAccounts, issueCustomerInvoice,
  listAccounts, markSupplierInvoicePaid, setAccountingProfile, setCustomerAccounts, setSupplierAccounts, uploadFile, createCreditNoteDraft,
} from "../src/modules/finance/service";
import { createAccountingExport } from "../src/modules/finance/export";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = new Date();
const Y = today.getUTCFullYear();
const prev = today.getUTCMonth() === 0 ? { y: Y - 1, m: 12 } : { y: Y, m: today.getUTCMonth() };
const addDays = (s: string, n: number) => iso(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86_400_000));
function nextMonday() { let d = addDays(iso(today), 1); while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1); return d; }

async function ctxOf(email: string, orgName = "Muster GmbH"): Promise<Ctx> {
  const org = await db.organization.findFirstOrThrow({ where: { name: orgName } });
  const user = await db.user.findUniqueOrThrow({ where: { email } });
  const m = await db.organizationMembership.findFirstOrThrow({ where: { userId: user.id, organizationId: org.id }, include: { role: true } });
  return { userId: user.id, organizationId: org.id, permissions: new Set(SYSTEM_ROLES[m.role.key]!.permissions as readonly Permission[]) as Ctx["permissions"] };
}
const step = async (name: string, f: () => Promise<unknown>) => { try { await f(); console.log("ok  ", name); } catch (e) { console.log("FAIL", name, (e as Error).message); } };

async function main() {
  const admin = await ctxOf("admin@demo.example");
  const emp = await ctxOf("mitarbeiter@demo.example");
  const mgr = await ctxOf("fuehrung@demo.example");
  const fin = await ctxOf("finanzen@demo.example");

  // ── Stammdaten ──
  const dep: Record<string, string> = {};
  for (const [code, name] of [["VW", "Verwaltung"], ["VT", "Vertrieb"], ["LG", "Lager & Logistik"]] as const) dep[code] = (await createDepartment(admin, { code, name })).id;
  const cc: Record<string, string> = {};
  for (const [code, name, d] of [["1000", "Verwaltung", "VW"], ["2000", "Vertrieb", "VT"], ["3000", "Logistik", "LG"]] as const) cc[code] = (await createCostCenter(admin, { code, name, departmentId: dep[d] })).id;
  for (const [c, amount] of [["1000", "40000"], ["2000", "60000"], ["3000", "25000"]] as const) await setBudget(fin, { costCenterId: cc[c], fiscalYear: Y, amount });
  const sup: Record<string, string> = {};
  for (const [n, name, email] of [["L100", "Büro Hofer GmbH", "bestellung@buero-hofer.example"], ["L200", "IT-Handel Schmid KG", "vertrieb@it-schmid.example"], ["L300", "Möbelwerk Berger", "office@moebel-berger.example"], ["L400", "Reinigung Weiß e.U.", "info@reinigung-weiss.example"]] as const)
    sup[n] = (await createSupplier(admin, { number: n, name, email })).id;

  // ── Personal ──
  const staff: [string, string, string, string, string][] = [
    ["110", "Sabine", "Aigner", "Verkauf", "VT"], ["111", "Tobias", "Gruber", "Verkauf", "VT"], ["112", "Lena", "Huber", "Kassa", "VT"],
    ["113", "Marko", "Petrović", "Lagerlogistik", "LG"], ["114", "Julia", "Wimmer", "Büroassistenz", "VW"],
  ];
  for (const [number, firstName, lastName, jobTitle, d] of staff) {
    const e = await createEmployee(admin, { number, firstName, lastName, jobTitle, departmentId: dep[d] });
    await addLeaveEntry(admin, { employeeId: e.id, year: Y, kind: "ENTITLEMENT", days: "25", note: "Jahresanspruch" });
  }
  const employees = await listEmployees(admin);
  const eid = (last: string) => employees.find((e) => e.lastName === last)!.id;
  await step("Abwesenheiten", async () => {
    const d1 = addDays(iso(today), 21);
    await requestAbsence(emp, { typeKey: "VACATION", startDate: d1, endDate: addDays(d1, 4), note: "Skiurlaub" });
    const r2 = await requestAbsence(emp, { typeKey: "VACATION", startDate: addDays(d1, 12), endDate: addDays(d1, 13), note: "Brückentage" });
    await requestAbsence(admin, { typeKey: "SICK", startDate: addDays(iso(today), -9), endDate: addDays(iso(today), -8), note: null });
    void r2;
  });
  await step("Urlaub freigeben", async () => {
    const a = await db.absenceRequest.findFirstOrThrow({ where: { note: "Skiurlaub" } });
    await decideAbsence(mgr, { absenceId: a.id, decision: "APPROVE", comment: "Viel Spaß!" });
  });

  // ── Beschaffung ──
  await step("Beschaffung", async () => {
    const r1 = await createRequest(emp, { title: "Laptops für Vertrieb", costCenterId: cc["2000"], lines: [{ description: "Laptop 14 Zoll", quantity: "3", unitPrice: "1200" }] });
    await decideRequest(mgr, { requestId: r1.id, decision: "APPROVE", comment: "Passt." });
    await createOrder(admin, { requestId: r1.id, supplierId: sup["L200"]!, costCenterId: cc["2000"]! });
    const r2 = await createRequest(emp, { title: "Büromöbel Besprechungsraum", costCenterId: cc["1000"], lines: [{ description: "Konferenztisch", quantity: "1", unitPrice: "4800" }, { description: "Stühle", quantity: "8", unitPrice: "420" }] });
    await decideRequest(mgr, { requestId: r2.id, decision: "APPROVE", comment: null });
    await createRequest(emp, { title: "Verpackungsmaterial Quartal", costCenterId: cc["3000"], lines: [{ description: "Kartons 40x30", quantity: "500", unitPrice: "0.85" }, { description: "Klebeband", quantity: "40", unitPrice: "2.40" }] });
    const r4 = await createRequest(emp, { title: "Kaffeevollautomat", costCenterId: cc["1000"], lines: [{ description: "Kaffeevollautomat", quantity: "1", unitPrice: "950" }] });
    await decideRequest(mgr, { requestId: r4.id, decision: "REJECT", comment: "Bitte erst Leasingangebot einholen." });
  });

  // ── Dienstplan ──
  await step("Dienstplan", async () => {
    const site = await createSite(admin, { name: "Filiale Wien Mitte", timeZone: "Europe/Vienna" });
    const kasse = await createQualification(admin, { name: "Kasse" });
    await setEmployeeQualification(admin, eid("Huber"), kasse.id, true);
    await setEmployeeQualification(admin, eid("Aigner"), kasse.id, true);
    await createTemplate(admin, { name: "Frühdienst", startTime: "07:30", endTime: "16:00", breakMinutes: 30, requiredCount: 2 });
    await createTemplate(admin, { name: "Spätdienst", startTime: "12:00", endTime: "20:30", breakMinutes: 30, requiredCount: 2, qualificationId: kasse.id });
    const mon = nextMonday();
    const roster = await createRoster(admin, { siteId: site.id, startDate: mon, endDate: addDays(mon, 6) });
    const crew = ["Gruber", "Petrović", "Wimmer"].map(eid);
    for (let i = 0; i < 6; i++) {
      const date = addDays(mon, i);
      const early = await addShift(admin, { rosterId: roster.id, date, startTime: "07:30", endTime: "16:00", breakMinutes: 30, requiredCount: 2, label: "Frühdienst" });
      await assignEmployee(admin, { shiftId: early.id, employeeId: crew[i % 3]! });
      await assignEmployee(admin, { shiftId: early.id, employeeId: crew[(i + 1) % 3]! });
      const late = await addShift(admin, { rosterId: roster.id, date, startTime: "12:00", endTime: "20:30", breakMinutes: 30, requiredCount: 2, qualificationId: kasse.id, label: "Spätdienst" });
      await assignEmployee(admin, { shiftId: late.id, employeeId: i % 2 === 0 ? eid("Huber") : eid("Aigner") });
    }
    await publishRoster(admin, roster.id, "Erste Fassung");
  });

  // ── Zeiterfassung (Vormonat) ──
  await step("Zeiterfassung", async () => {
    await setPayCodeRules(admin, { NIGHT: 25, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 });
    const who = [eid("Mitarbeiter"), eid("Führung"), eid("Finanzen"), eid("Admin")];
    const last = new Date(Date.UTC(prev.y, prev.m, 0)).getUTCDate();
    for (const employeeId of who) {
      for (let d = 1; d <= last; d++) {
        const date = `${prev.y}-${pad(prev.m)}-${pad(d)}`;
        const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (wd === 0 || wd === 6) continue;
        const end = d % 7 === 3 ? "17:30" : "16:30";
        await addEntryDirect(admin, { employeeId, date, startTime: "08:00", endTime: end, breakMinutes: 30, reason: "Erfassung Demo" }).catch(() => undefined);
      }
    }
    for (const [c, e] of [[emp, "Mitarbeiter"], [mgr, "Führung"], [fin, "Finanzen"], [admin, "Admin"]] as const) {
      await submitPeriod(c, { year: prev.y, month: prev.m }).catch((x) => console.log("  submit", e, (x as Error).message));
      await approvePeriod(e === "Führung" ? admin : mgr, { employeeId: eid(e), year: prev.y, month: prev.m }).catch((x) => console.log("  approve", e, (x as Error).message));
    }
    await clockIn(emp, {}).catch(() => undefined);
  });

  // ── Lohn-Export ──
  await step("Lohn-Export", async () => {
    await setPayrollProfile(admin, {
      delimiter: ";", decimalSeparator: ",", includeHeader: true, encoding: "utf8-bom", unit: "HOURS", includeSurcharge: true,
      codes: { NORMAL: "1000", MEHRZEIT: "1100", NIGHT: "2000", SUNDAY: "2100", HOLIDAY: "2200", VACATION: "3000", SICK: "3100", CARE: "3200", SPECIAL: "3300" },
    });
    await createPayrollExport(admin, { year: prev.y, month: prev.m, acceptIncomplete: true });
  });

  // ── Finanzen ──
  await step("Finanzen", async () => {
    await importAccounts(fin, "4000;Erlöse Beratung 20 %\n4100;Erlöse Verkauf 20 %\n5000;Wareneinkauf\n7000;Aufwand Material\n7100;Aufwand Dienstleistungen\n7200;Aufwand Büro und IT");
    await createAccount(fin, { number: "33100", name: "Kreditor Büro Hofer", type: "VENDOR" });
    await createAccount(fin, { number: "33200", name: "Kreditor IT-Handel Schmid", type: "VENDOR" });
    await createAccount(fin, { number: "33300", name: "Kreditor Möbelwerk Berger", type: "VENDOR" });
    await createAccount(fin, { number: "20100", name: "Debitor Alpenblick Hotels", type: "CUSTOMER" });
    await createAccount(fin, { number: "20200", name: "Debitor Stadtwerke Beispielstadt", type: "CUSTOMER" });
    const acc = Object.fromEntries((await listAccounts(fin)).map((a) => [a.number, a.id]));
    const vst20 = (await createTaxCode(fin, { key: "vst20", name: "Vorsteuer 20 %", rate: "20", direction: "INPUT", bmdCode: "2", datevKey: "9" })).id;
    const vst10 = (await createTaxCode(fin, { key: "vst10", name: "Vorsteuer 10 %", rate: "10", direction: "INPUT", bmdCode: "3", datevKey: "8" })).id;
    const ust20 = (await createTaxCode(fin, { key: "ust20", name: "Umsatzsteuer 20 %", rate: "20", direction: "OUTPUT", bmdCode: "1", datevKey: "3" })).id;
    await setSupplierAccounts(fin, sup["L100"]!, { uid: "ATU11111111", accountId: acc["33100"], lineAccountId: acc["7200"] });
    await setSupplierAccounts(fin, sup["L200"]!, { uid: "ATU22222222", accountId: acc["33200"], lineAccountId: acc["7200"] });
    await setSupplierAccounts(fin, sup["L300"]!, { uid: "ATU33333333", accountId: acc["33300"], lineAccountId: acc["7000"] });
    const c1 = (await createCustomer(fin, { number: "K100", name: "Alpenblick Hotels GmbH", street: "Seestraße 12", zip: "5020", city: "Salzburg", country: "AT", uid: "ATU44444444", paymentTermsDays: 14 })).id;
    const c2 = (await createCustomer(fin, { number: "K200", name: "Stadtwerke Beispielstadt", street: "Ringstraße 1", zip: "4020", city: "Linz", country: "AT", uid: "ATU55555555", paymentTermsDays: 30 })).id;
    await setCustomerAccounts(fin, c1, { accountId: acc["20100"], lineAccountId: acc["4000"] });
    await setCustomerAccounts(fin, c2, { accountId: acc["20200"], lineAccountId: acc["4000"] });
    await setAccountingProfile(fin, { format: "DATEV", advisorNumber: "12345", clientNumber: "67890", accountLength: 4, fiscalYearStartMonth: 1, symbolIn: "ER", symbolOut: "AR", dictationCode: "", includeFiles: true });

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
    const day = (n: number) => addDays(iso(today), -n);
    const inv: [string, string, string, string, string, string, string][] = [
      // Lieferant, Nr, Beschreibung, Netto, Steuer, Tage zurück, Fällig in Tagen
      ["L100", "2026-0815", "Büromaterial Oktober", "184.50", vst20, "30", "14"],
      ["L200", "IT-77412", "3 Laptops 14 Zoll", "3600.00", vst20, "24", "30"],
      ["L300", "MB-2210", "Konferenztisch und Stühle", "8160.00", vst20, "20", "30"],
      ["L100", "2026-0901", "Fachliteratur", "96.00", vst10, "8", "14"],
      ["L200", "IT-77690", "Wartungsvertrag Dezember", "420.00", vst20, "3", "30"],
    ];
    const created: string[] = [];
    for (const [s, no, d, net, tax, back] of inv) {
      const f = await uploadFile(admin, { name: `Rechnung-${no}.pdf`, bytes: pdf });
      created.push((await createSupplierInvoice(admin, { supplierId: sup[s], invoiceNumber: no, invoiceDate: day(Number(back)), dueDate: addDays(day(Number(back)), 30), fileId: f.id, lines: [{ description: d, netAmount: net, taxCodeId: tax, costCenterId: s === "L200" ? cc["2000"] : cc["1000"] }] })).id);
    }
    for (const id of created.slice(0, 4)) await approveSupplierInvoice(fin, id);
    await markSupplierInvoicePaid(fin, { id: created[0]!, paidOn: day(10) }).catch((e) => console.log("  paid", (e as Error).message));

    const outs: [string, string, string, string, string][] = [
      [c1, "Beratungsleistung Oktober", "12", "95", "26"], [c2, "Workshop Prozessoptimierung", "2", "1450", "18"], [c1, "Schulung Mitarbeiter", "6", "120", "6"],
    ];
    const oids: string[] = [];
    for (const [cid, d, q, p, back] of outs) {
      const i = await createCustomerInvoice(fin, { customerId: cid, invoiceDate: day(Number(back)), lines: [{ description: d, quantity: q, unitPrice: p, taxCodeId: ust20, costCenterId: cc["2000"] }] });
      await issueCustomerInvoice(fin, i.id);
      oids.push(i.id);
    }
    await createCreditNoteDraft(fin, oids[2]!).catch((e) => console.log("  credit", (e as Error).message));
    await createAccountingExport(fin, { upTo: day(7), acceptWarnings: true });
  });

  await runOutbox({ organizationId: admin.organizationId, batch: 500 }).catch((e) => console.log("outbox", (e as Error).message));
  console.log("Szenario fertig");
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
