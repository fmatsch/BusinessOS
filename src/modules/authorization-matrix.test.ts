import { describe, expect, it } from "vitest";
import { ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { PERMISSIONS, SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { publishPolicy, readPolicy } from "@/platform/approvals/policy";
import { addEmployment, addLeaveEntry, closeEmployment, createEmployee, decideAbsence, listEmployees, listPendingAbsenceApprovals, listAbsences, requestAbsence, updateEmployee, writeSensitive } from "./hr/service";
import { addShift, assignEmployee, createQualification, createRoster, createSite, createTemplate, decideSwap, getRoster, getRules, listRosters, publishRoster, removeShift, requestSwap, setEmployeeQualification, setRules, unassignEmployee } from "./roster/service";
import { addAccountAdjustment, addEntryDirect, cancelRequest, clockIn, clockOut, correctEntryDirect, deleteEntryDirect, discardClock, endBreak, getClock, getPayCodeRules, listTeam, reopenPeriod, requestEntry, setPayCodeRules, startBreak, submitPeriod } from "./time/service";
import { createExport, getExportFile, getProfile, listExports, setProfile } from "./payroll/service";
import { createRecurring, listRecurring, runRecurringInvoices, setRecurringActive } from "./finance/recurring-invoices";
import { createDunningNotice, getDunningPdf, listOpenItems } from "./finance/receivables";
import { acceptInvoiceVariance, getInvoiceMatch, approveSupplierInvoice, cancelCustomerInvoiceDraft, createAccount, createCustomer, createCustomerInvoice, createSupplierInvoice, createTaxCode, financeOverview, getAccountingProfile, getCustomerInvoice, getCustomerInvoicePdf, getIssuerProfile, setIssuerProfile, getFile, getSupplierInvoice, importAccounts, issueCustomerInvoice, listAccounts, listCustomerInvoices, listCustomers, listSupplierInvoices, listTaxCodes, markSupplierInvoicePaid, setAccountingProfile, setCustomerAccounts, setSupplierAccounts, updateTaxMapping, uploadFile } from "./finance/service";
import { createAccountingExport, getAccountingExportFile, listAccountingExports, previewAccountingExport } from "./finance/export";
import { budgetOverview, committedByDepartment, setBudget } from "./budget/service";
import { createCostCenter, createDepartment, listCostCenters, listDepartments } from "./masterdata/service";
import { createOrder, createRequest, createSupplier, getOrderReceiving, getRequest, listOrders, listRequests, listSuppliers, recordReceipt, reverseReceipt } from "./procurement/service";

const none: Ctx = { userId: "u", organizationId: "o", permissions: new Set<Permission>() };
const valid = {
  department: { code: "D1", name: "Test" },
  costCenter: { code: "K1", name: "Test" },
  supplier: { number: "L1", name: "Test" },
  request: { title: "Test", lines: [{ description: "x", quantity: "1", unitPrice: "1" }] },
  order: { requestId: "r", supplierId: "s", costCenterId: "c" },
  budget: { costCenterId: "c", fiscalYear: 2026, amount: "1" },
};

/** Jede Service-Funktion muss ohne die passende Berechtigung verweigern – und zwar bevor die Datenbank berührt wird. */
const protectedOperations: [string, Permission, () => Promise<unknown>][] = [
  ["listDepartments", "master.department.read", () => listDepartments(none)],
  ["createDepartment", "master.department.write", () => createDepartment(none, valid.department)],
  ["listCostCenters", "master.costcenter.read", () => listCostCenters(none)],
  ["createCostCenter", "master.costcenter.write", () => createCostCenter(none, valid.costCenter)],
  ["listSuppliers", "procurement.supplier.read", () => listSuppliers(none)],
  ["createSupplier", "procurement.supplier.write", () => createSupplier(none, valid.supplier)],
  ["listRequests", "procurement.request.create", () => listRequests(none)],
  ["getRequest", "procurement.request.create", () => getRequest(none, "x")],
  ["createRequest", "procurement.request.create", () => createRequest(none, valid.request)],
  ["listOrders", "procurement.order.create", () => listOrders(none)],
  ["createOrder", "procurement.order.create", () => createOrder(none, valid.order)],
  ["budgetOverview", "finance.budget.read", () => budgetOverview(none, 2026)],
  ["committedByDepartment", "finance.budget.read", () => committedByDepartment(none, 2026)],
  ["setBudget", "finance.budget.write", () => setBudget(none, valid.budget)],
  ["listEmployees", "hr.employee.read", () => listEmployees(none)],
  ["createEmployee", "hr.employee.write", () => createEmployee(none, { number: "1", firstName: "a", lastName: "b" })],
  ["updateEmployee", "hr.employee.write", () => updateEmployee(none, "x", { firstName: "a", lastName: "b" })],
  ["writeSensitive", "hr.employee.write_sensitive", () => writeSensitive(none, "x", {})],
  ["addEmployment", "hr.employment.write", () => addEmployment(none, { employeeId: "x", validFrom: "2026-01-01", contractType: "FULL_TIME", weeklyHours: "40" })],
  ["closeEmployment", "hr.employment.write", () => closeEmployment(none, "x", "2026-01-01")],
  ["addLeaveEntry", "hr.leave.write", () => addLeaveEntry(none, { employeeId: "x", year: 2026, kind: "ENTITLEMENT", days: "1" })],
  ["requestAbsence", "hr.absence.request", () => requestAbsence(none, { typeKey: "VACATION", startDate: "2026-01-05", endDate: "2026-01-05" })],
  ["listAbsences(all)", "hr.absence.read_all", () => listAbsences(none, "all")],
  ["listAbsences(team)", "hr.absence.approve", () => listAbsences({ ...none, userId: "nobody" }, "team")],
  ["listRosters", "roster.read_all", () => listRosters(none)],
  ["getRoster", "roster.read_all", () => getRoster(none, "x")],
  ["getRules", "roster.read_all", () => getRules(none)],
  ["createSite", "roster.plan", () => createSite(none, { name: "x", timeZone: "Europe/Vienna" })],
  ["createQualification", "roster.plan", () => createQualification(none, { name: "x" })],
  ["setEmployeeQualification", "roster.plan", () => setEmployeeQualification(none, "e", "q", true)],
  ["createTemplate", "roster.plan", () => createTemplate(none, { name: "x", startTime: "08:00", endTime: "16:00", breakMinutes: 30, requiredCount: 1 })],
  ["createRoster", "roster.plan", () => createRoster(none, { siteId: "s", startDate: "2027-01-04", endDate: "2027-01-10" })],
  ["addShift", "roster.plan", () => addShift(none, { rosterId: "r", date: "2027-01-04", startTime: "08:00", endTime: "16:00", breakMinutes: 30, requiredCount: 1 })],
  ["removeShift", "roster.plan", () => removeShift(none, "s")],
  ["assignEmployee", "roster.plan", () => assignEmployee(none, { shiftId: "s", employeeId: "e" })],
  ["unassignEmployee", "roster.plan", () => unassignEmployee(none, "s", "e")],
  ["publishRoster", "roster.publish", () => publishRoster(none, "r")],
  ["setRules", "roster.rules.manage", () => setRules(none, { restDailyMinutes: 660, maxDailyMinutes: 720, maxWeeklyMinutes: 3600, breakAfterMinutes: 360, minBreakMinutes: 30, weeklyRestMinutes: 2160 })],
  ["requestSwap", "roster.swap.request", () => requestSwap(none, { shiftId: "s", toEmployeeId: "e" })],
  ["decideSwap", "roster.swap.approve", () => decideSwap(none, "x", true)],
  ["getClock", "time.entry.own", () => getClock(none)],
  ["clockIn", "time.entry.own", () => clockIn(none)],
  ["startBreak", "time.entry.own", () => startBreak(none)],
  ["endBreak", "time.entry.own", () => endBreak(none)],
  ["clockOut", "time.entry.own", () => clockOut(none)],
  ["discardClock", "time.entry.own", () => discardClock(none)],
  ["requestEntry", "time.entry.own", () => requestEntry(none, { type: "DELETE", targetEntryId: "x", reason: "Test" })],
  ["cancelRequest", "time.entry.own", () => cancelRequest(none, "x")],
  ["submitPeriod", "time.entry.own", () => submitPeriod(none, { year: 2026, month: 1 })],
  ["addEntryDirect", "time.entry.correct", () => addEntryDirect(none, { employeeId: "x", date: "2026-01-05", startTime: "08:00", endTime: "09:00", reason: "Test" })],
  ["correctEntryDirect", "time.entry.correct", () => correctEntryDirect(none, { entryId: "x", date: "2026-01-05", startTime: "08:00", endTime: "09:00", reason: "Test" })],
  ["deleteEntryDirect", "time.entry.correct", () => deleteEntryDirect(none, { entryId: "x", reason: "Test" })],
  ["reopenPeriod", "time.period.reopen", () => reopenPeriod(none, { employeeId: "x", year: 2026, month: 1, reason: "Test" })],
  ["addAccountAdjustment", "time.account.write", () => addAccountAdjustment(none, { employeeId: "x", minutes: 10, note: "Test" })],
  ["setPayCodeRules", "time.rules.manage", () => setPayCodeRules(none, { NIGHT: 25, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 })],
  ["getPayCodeRules", "time.entry.read_all", () => getPayCodeRules(none)],
  ["listTeam", "time.period.approve", () => listTeam(none, 2026, 1)],
  ["getProfile", "payroll.export.read", () => getProfile(none)],
  ["listExports", "payroll.export.read", () => listExports(none)],
  ["getExportFile", "payroll.export.read", () => getExportFile(none, "x")],
  ["createExport", "payroll.export.create", () => createExport(none, { year: 2026, month: 1 })],
  ["setProfile", "payroll.profile.manage", () => setProfile(none, {})],
  ["listAccounts", "finance.master.read", () => listAccounts(none)],
  ["listTaxCodes", "finance.master.read", () => listTaxCodes(none)],
  ["listCustomers", "finance.master.read", () => listCustomers(none)],
  ["createAccount", "finance.master.write", () => createAccount(none, { number: "1", name: "x", type: "GL" })],
  ["importAccounts", "finance.master.write", () => importAccounts(none, "1;x")],
  ["createTaxCode", "finance.master.write", () => createTaxCode(none, { key: "x", name: "x", rate: "20", direction: "INPUT" })],
  ["updateTaxMapping", "finance.master.write", () => updateTaxMapping(none, "x", {})],
  ["createCustomer", "finance.master.write", () => createCustomer(none, { number: "1", name: "x" })],
  ["setSupplierAccounts", "finance.master.write", () => setSupplierAccounts(none, "x", {})],
  ["setCustomerAccounts", "finance.master.write", () => setCustomerAccounts(none, "x", {})],
  ["setIssuerProfile", "finance.master.write", () => setIssuerProfile(none, { legalName: "x" })],
  ["setAccountingProfile", "finance.master.write", () => setAccountingProfile(none, { format: "BMD", accountLength: 4, fiscalYearStartMonth: 1, symbolIn: "ER", symbolOut: "AR", includeFiles: true })],
  ["listRecurring", "finance.invoice.read", () => listRecurring(none)],
  ["createRecurring", "finance.recurring.manage", () => createRecurring(none, {})],
  ["setRecurringActive", "finance.recurring.manage", () => setRecurringActive(none, "x", false)],
  ["runRecurringInvoices", "finance.recurring.manage", () => runRecurringInvoices(none)],
  ["listOpenItems", "finance.invoice.read", () => listOpenItems(none)],
  ["getDunningPdf", "finance.invoice.read", () => getDunningPdf(none, "x")],
  ["createDunningNotice", "finance.dunning.create", () => createDunningNotice(none, { invoiceId: "x" })],
  ["getIssuerProfile", "finance.master.read", () => getIssuerProfile(none)],
  ["getCustomerInvoicePdf", "finance.invoice.read", () => getCustomerInvoicePdf(none, "x")],
  ["getAccountingProfile", "finance.export.read", () => getAccountingProfile(none)],
  ["uploadFile", "finance.invoice.in.create", () => uploadFile(none, { name: "x.pdf", bytes: new Uint8Array([1]) })],
  ["getFile", "finance.invoice.read", () => getFile(none, "x")],
  ["createSupplierInvoice", "finance.invoice.in.create", () => createSupplierInvoice(none, { supplierId: "s", invoiceNumber: "1", invoiceDate: "2026-01-05", lines: [{ description: "x", netAmount: "1", taxCodeId: "t" }] })],
  ["approveSupplierInvoice", "finance.invoice.in.approve", () => approveSupplierInvoice(none, "x")],
  ["markSupplierInvoicePaid", "finance.invoice.in.approve", () => markSupplierInvoicePaid(none, { id: "x", paidOn: "2026-01-05" })],
  ["listSupplierInvoices", "finance.invoice.read", () => listSupplierInvoices(none)],
  ["getSupplierInvoice", "finance.invoice.read", () => getSupplierInvoice(none, "x")],
  ["createCustomerInvoice", "finance.invoice.out.create", () => createCustomerInvoice(none, { customerId: "c", invoiceDate: "2026-01-05", lines: [{ description: "x", quantity: "1", unitPrice: "1", taxCodeId: "t" }] })],
  ["cancelCustomerInvoiceDraft", "finance.invoice.out.create", () => cancelCustomerInvoiceDraft(none, "x")],
  ["issueCustomerInvoice", "finance.invoice.out.issue", () => issueCustomerInvoice(none, "x")],
  ["listCustomerInvoices", "finance.invoice.read", () => listCustomerInvoices(none)],
  ["getCustomerInvoice", "finance.invoice.read", () => getCustomerInvoice(none, "x")],
  ["financeOverview", "finance.invoice.read", () => financeOverview(none)],
  ["previewAccountingExport", "finance.export.read", () => previewAccountingExport(none)],
  ["listAccountingExports", "finance.export.read", () => listAccountingExports(none)],
  ["getAccountingExportFile", "finance.export.read", () => getAccountingExportFile(none, "x", "data")],
  ["createAccountingExport", "finance.export.create", () => createAccountingExport(none, {})],
  ["getOrderReceiving", "procurement.receipt.read", () => getOrderReceiving(none, "x")],
  ["recordReceipt", "procurement.receipt.create", () => recordReceipt(none, { orderId: "x", receivedOn: "2026-01-05", lines: [{ requestLineId: "y", quantity: "1" }] })],
  ["reverseReceipt", "procurement.receipt.create", () => reverseReceipt(none, "x", "Grund")],
  ["getInvoiceMatch", "finance.invoice.read", () => getInvoiceMatch(none, "x")],
  ["acceptInvoiceVariance", "finance.invoice.in.accept_variance", () => acceptInvoiceVariance(none, "x", "Begründung")],
  ["publishPolicy", "org.settings.manage", () => publishPolicy(none, [])],
  ["readPolicy", "org.settings.manage", () => readPolicy(none)],
];

describe("Autorisierungsmatrix: Services", () => {
  it.each(protectedOperations)("%s verweigert ohne %s", async (_name, permission, op) => {
    const error = await op().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).permission).toBe(permission);
  });

  it("jede registrierte Schreib-Permission wird von mindestens einer Operation geschützt", () => {
    const guarded = new Set(protectedOperations.map(([, p]) => p));
    const writes = PERMISSIONS.filter((p) => /\.(write|create)$/.test(p));
    expect(writes.filter((p) => !guarded.has(p))).toEqual([]);
  });
});

describe("Autorisierungsmatrix: Rollen", () => {
  const roles = (p: Permission) => Object.entries(SYSTEM_ROLES).filter(([, r]) => r.permissions.includes(p)).map(([k]) => k).sort();

  it("Organisations-Verwaltung und Audit-Zugriff gehören nur dem Inhaber (Audit zusätzlich Finanzen)", () => {
    expect(roles("org.settings.manage")).toEqual(["owner"]);
    expect(roles("org.members.manage")).toEqual(["owner"]);
    expect(roles("org.audit.read")).toEqual(["finance", "owner"]);
  });
  it("Sensible HR-Daten sehen nur Inhaber und Personalwesen – nicht Führungskräfte, Finanzen oder Mitarbeiter", () => {
    expect(roles("hr.employee.read_sensitive")).toEqual(["hr", "owner"]);
    expect(roles("hr.employee.write_sensitive")).toEqual(["hr", "owner"]);
    expect(roles("hr.employment.read")).toEqual(["hr", "owner"]); // Wochenstunden/Vertragsart
  });
  it("Urlaubskonto buchen und alle Abwesenheiten sehen: Personalwesen und Inhaber", () => {
    expect(roles("hr.leave.write")).toEqual(["hr", "owner"]);
    expect(roles("hr.absence.read_all")).toEqual(["hr", "owner"]);
    expect(roles("hr.absence.approve_all")).toEqual(["hr", "owner"]);
    expect(roles("hr.absence.approve")).toEqual(["hr", "manager", "owner"]); // Führungskraft nur für das eigene Team (Service prüft)
  });
  it("Dienstplan: planen/veröffentlichen nur Dienstplanung und Inhaber; Regeln nur Inhaber; Führungskräfte lesen und geben Tausch frei", () => {
    expect(roles("roster.plan")).toEqual(["owner", "scheduler"]);
    expect(roles("roster.publish")).toEqual(["owner", "scheduler"]);
    expect(roles("roster.rules.manage")).toEqual(["owner"]);
    expect(roles("roster.read_all")).toEqual(["manager", "owner", "scheduler"]);
    expect(roles("roster.swap.approve")).toEqual(["manager", "owner", "scheduler"]);
    expect(roles("roster.swap.request")).toEqual(["employee", "finance", "hr", "manager", "owner", "scheduler"]);
  });
  it("Zeiterfassung: alle stempeln; Fremdzugriff, Direktkorrektur, Wiedereröffnen, Zeitkonto und Regeln nur Personalwesen/Inhaber; Führungskraft gibt Team frei", () => {
    expect(roles("time.entry.own")).toEqual(["employee", "finance", "hr", "manager", "owner", "scheduler"]);
    for (const p of ["time.entry.read_all", "time.entry.correct", "time.period.approve_all", "time.period.reopen", "time.account.write", "time.rules.manage"] as const)
      expect(roles(p)).toEqual(["hr", "owner"]);
    expect(roles("time.period.approve")).toEqual(["hr", "manager", "owner"]);
  });
  it("Lohn-Export: lesen Personalwesen, Finanzen und Inhaber; erzeugen und Format nur Personalwesen und Inhaber", () => {
    expect(roles("payroll.export.read")).toEqual(["finance", "hr", "owner"]);
    expect(roles("payroll.export.create")).toEqual(["hr", "owner"]);
    expect(roles("payroll.profile.manage")).toEqual(["hr", "owner"]);
  });
  it("Finanzen: alle Belegfunktionen und der Export nur für Finanzen und Inhaber; Personalwesen, Führungskräfte und Mitarbeiter haben keinen Zugriff", () => {
    for (const p of ["finance.master.read", "finance.master.write", "finance.invoice.read", "finance.invoice.in.create", "finance.invoice.in.approve", "finance.invoice.out.create", "finance.invoice.out.issue", "finance.export.read", "finance.export.create"] as const)
      expect(roles(p)).toEqual(["finance", "owner"]);
  });
  it("jeder Benutzer mit einer Rolle darf Abwesenheit beantragen", () => {
    expect(roles("hr.absence.request")).toEqual(["employee", "finance", "hr", "manager", "owner", "scheduler"]);
  });
  it("Freigabe: Führungskraft und Inhaber für Schritt 1, Finanzen und Inhaber für Schritt 2", () => {
    expect(roles("procurement.request.approve")).toEqual(["manager", "owner"]);
    expect(roles("procurement.request.approve_finance")).toEqual(["finance", "owner"]);
  });
  it("Mitarbeiter dürfen nur anfordern und Stammdaten lesen – nichts schreiben oder freigeben", () => {
    const perms = SYSTEM_ROLES.employee!.permissions;
    expect(perms.filter((p) => !p.endsWith(".read") && !["procurement.request.create", "hr.absence.request", "roster.swap.request", "time.entry.own"].includes(p))).toEqual([]);
  });
  it("Budgets ändern dürfen nur Finanzen und Inhaber", () => {
    expect(roles("finance.budget.write")).toEqual(["finance", "owner"]);
  });
});
