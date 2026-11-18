import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, can, ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import type { Permission } from "@/platform/authz/permissions";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { stepsFor } from "@/platform/approvals/engine";
import { EXPENSE_REPORT, getActivePolicy } from "@/platform/approvals/policy";
import { dateFromIso, employeeBasics, employeeByUser, isoFromDate } from "@/modules/hr/queries";
import { loadVerifiedFile, storeVerifiedFile } from "@/modules/finance/service";
import { decisionInput, lineInput, mileageRateInput, paidInput, reportInput } from "./schema";
import { canTransition, lineDateProblem, mileageAmount, sumAmounts, type ExpenseStatus } from "./rules";

type Tx = Prisma.TransactionClient;
const todayIso = () => isoFromDate(new Date());
const lockReport = (tx: Tx, organizationId: string, id: string) => tx.$queryRaw`SELECT id FROM "ExpenseReport" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

async function nextNumber(tx: Tx, organizationId: string, year: number) {
  const key = `EX-${year}`;
  const seq = await tx.sequence.upsert({ where: { organizationId_key: { organizationId, key } }, create: { organizationId, key, value: 1 }, update: { value: { increment: 1 } } });
  return `${key}-${String(seq.value).padStart(4, "0")}`;
}

// ───────────────────────── Einstellungen ─────────────────────────

export async function getMileageRate(ctx: Ctx, tx: Tx | typeof db = db): Promise<Decimal> {
  const s = await tx.expenseSettings.findUnique({ where: { organizationId: ctx.organizationId } });
  return new Decimal((s?.mileageRate ?? 0.5).toString());
}

export async function setMileageRate(ctx: Ctx, raw: unknown) {
  authorize(ctx, "finance.master.write");
  const rate = mileageRateInput.parse(raw);
  return db.$transaction(async (tx) => {
    const before = await getMileageRate(ctx, tx);
    await tx.expenseSettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, mileageRate: rate.toString() }, update: { mileageRate: rate.toString() } });
    await writeAudit(tx, ctx, { action: "expense_settings.mileage_rate", entityType: "ExpenseSettings", entityId: ctx.organizationId, before: { rate: before.toString() }, after: { rate: rate.toString() } });
  });
}

// ───────────────────────── Zugriff ─────────────────────────

/** Darf die Person die Abrechnung sehen? Eigene, Teamabrechnungen (Freigeber der Führungskraft-Stufe) und – mit `expense.read_all` – alle. */
async function canSee(ctx: Ctx, tx: Tx | typeof db, report: { employeeId: string }) {
  if (can(ctx, "expense.read_all")) return true;
  const me = await employeeByUser(tx as Tx, ctx.organizationId, ctx.userId);
  if (me && me.id === report.employeeId) return true;
  if (me && can(ctx, "expense.approve")) {
    const [emp] = await employeeBasics(tx as Tx, ctx.organizationId, [report.employeeId]);
    if (emp?.managerId === me.id) return true;
  }
  return false;
}

async function requireOwn(tx: Tx, ctx: Ctx, report: { employeeId: string }) {
  const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
  if (!me || me.id !== report.employeeId) throw new ForbiddenError("expense.submit");
  return me;
}

// ───────────────────────── Abrechnung erfassen ─────────────────────────

export async function createExpenseReport(ctx: Ctx, raw: unknown) {
  authorize(ctx, "expense.submit");
  const input = reportInput.parse(raw);
  return db.$transaction(async (tx) => {
    const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
    if (!me || !me.active) throw new ConflictError("Ihrem Benutzerkonto ist kein aktives Mitarbeiterprofil zugeordnet");
    if (input.costCenterId && !(await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
    const created = await tx.expenseReport.create({
      data: { organizationId: ctx.organizationId, employeeId: me.id, title: input.title, tripFrom: input.tripFrom ? dateFromIso(input.tripFrom) : null, tripTo: input.tripTo ? dateFromIso(input.tripTo) : null, costCenterId: input.costCenterId ?? null, note: input.note ?? null },
    });
    await writeAudit(tx, ctx, { action: "expense.create", entityType: "ExpenseReport", entityId: created.id, after: { title: input.title } });
    return created;
  });
}

/** Position hinzufügen (nur im Entwurf, nur eigene). Kilometergeld: `amount` sind die km, der Betrag folgt aus dem Kilometersatz. */
export async function addExpenseLine(ctx: Ctx, raw: unknown, receipt?: { name: string; bytes: Uint8Array } | null) {
  authorize(ctx, "expense.submit");
  const input = lineInput.parse(raw);
  const fileId = receipt && receipt.bytes.length > 0 ? (await storeVerifiedFile(ctx, receipt)).id : null;
  return db.$transaction(async (tx) => {
    await lockReport(tx, ctx.organizationId, input.reportId);
    const r = await tx.expenseReport.findFirst({ where: { id: input.reportId, organizationId: ctx.organizationId } });
    if (!r) throw new NotFoundError("Spesenabrechnung");
    await requireOwn(tx, ctx, r);
    if (r.status !== "DRAFT") throw new ConflictError("Positionen können nur im Entwurf geändert werden");
    const problem = lineDateProblem(input.date, todayIso(), r.tripFrom ? isoFromDate(r.tripFrom) : null, r.tripTo ? isoFromDate(r.tripTo) : null);
    if (problem) throw new ConflictError(problem);
    const mileage = input.category === "MILEAGE";
    const amount = mileage ? mileageAmount(input.amount, await getMileageRate(ctx, tx)) : input.amount.toDecimalPlaces(2);
    if (amount.lte(0)) throw new ConflictError("Der Betrag ist zu klein");
    const line = await tx.expenseLine.create({ data: { reportId: r.id, date: dateFromIso(input.date), category: input.category, description: input.description, quantity: mileage ? input.amount.toString() : null, amount: amount.toString(), receiptFileId: fileId } });
    const lines = await tx.expenseLine.findMany({ where: { reportId: r.id }, select: { amount: true } });
    await tx.expenseReport.update({ where: { id: r.id }, data: { totalAmount: sumAmounts(lines.map((l) => l.amount.toString())).toString() } });
    await writeAudit(tx, ctx, { action: "expense.line_add", entityType: "ExpenseLine", entityId: line.id, after: { reportId: r.id, category: input.category, amount: amount.toString(), receipt: !!fileId } });
    return line;
  });
}

export async function removeExpenseLine(ctx: Ctx, lineId: string) {
  authorize(ctx, "expense.submit");
  return db.$transaction(async (tx) => {
    const line = await tx.expenseLine.findFirst({ where: { id: lineId, report: { organizationId: ctx.organizationId } }, include: { report: true } });
    if (!line) throw new NotFoundError("Position");
    await lockReport(tx, ctx.organizationId, line.reportId);
    const r = await tx.expenseReport.findFirstOrThrow({ where: { id: line.reportId } });
    await requireOwn(tx, ctx, r);
    if (r.status !== "DRAFT") throw new ConflictError("Positionen können nur im Entwurf geändert werden");
    await tx.expenseLine.delete({ where: { id: lineId } });
    const rest = await tx.expenseLine.findMany({ where: { reportId: r.id }, select: { amount: true } });
    await tx.expenseReport.update({ where: { id: r.id }, data: { totalAmount: sumAmounts(rest.map((l) => l.amount.toString())).toString() } });
    await writeAudit(tx, ctx, { action: "expense.line_remove", entityType: "ExpenseLine", entityId: lineId, after: { reportId: r.id } });
  });
}

// ───────────────────────── Einreichen, Freigeben, Auszahlen ─────────────────────────

/** Einreichen: Nummer vergeben, Freigabeschritte laut Regel (Objektart EXPENSE_REPORT) anlegen. Ab hier unveränderlich. */
export async function submitExpenseReport(ctx: Ctx, id: string) {
  authorize(ctx, "expense.submit");
  return db.$transaction(async (tx) => {
    await lockReport(tx, ctx.organizationId, id);
    const r = await tx.expenseReport.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
    if (!r) throw new NotFoundError("Spesenabrechnung");
    await requireOwn(tx, ctx, r);
    if (!canTransition(r.status as ExpenseStatus, "SUBMITTED")) throw new ConflictError("Nur Entwürfe können eingereicht werden");
    if (r.lines.length === 0) throw new ConflictError("Die Abrechnung hat keine Positionen");
    const policy = await getActivePolicy(tx, ctx.organizationId, EXPENSE_REPORT);
    const steps = stepsFor(policy.steps, r.totalAmount.toString());
    const number = await nextNumber(tx, ctx.organizationId, new Date().getUTCFullYear());
    await tx.expenseReport.update({
      where: { id }, data: { status: "SUBMITTED", number, submittedAt: new Date(), policyVersion: policy.version, approvals: { create: steps.map((s, i) => ({ organizationId: ctx.organizationId, stepKey: s.key, label: s.label, requiredPermission: s.permission, sequence: i + 1 })) } },
    });
    await writeAudit(tx, ctx, { action: "expense.submit", entityType: "ExpenseReport", entityId: id, after: { number, total: r.totalAmount.toString(), steps: steps.map((s) => s.key) } });
    return number;
  });
}

export async function cancelExpenseReport(ctx: Ctx, id: string) {
  authorize(ctx, "expense.submit");
  return db.$transaction(async (tx) => {
    await lockReport(tx, ctx.organizationId, id);
    const r = await tx.expenseReport.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!r) throw new NotFoundError("Spesenabrechnung");
    await requireOwn(tx, ctx, r);
    if (!canTransition(r.status as ExpenseStatus, "CANCELLED")) throw new ConflictError("Die Abrechnung kann nicht mehr zurückgezogen werden");
    await tx.expenseReport.update({ where: { id }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "expense.cancel", entityType: "ExpenseReport", entityId: id });
  });
}

/** Freigabeschritt entscheiden. Nicht die eigene Abrechnung; die Führungskraft-Stufe nur für das eigene Team (außer mit `expense.approve_all`). */
export async function decideExpenseReport(ctx: Ctx, raw: unknown) {
  const input = decisionInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockReport(tx, ctx.organizationId, input.reportId);
    const r = await tx.expenseReport.findFirst({ where: { id: input.reportId, organizationId: ctx.organizationId }, include: { approvals: { orderBy: { sequence: "asc" } } } });
    if (!r) throw new NotFoundError("Spesenabrechnung");
    if (r.status !== "SUBMITTED") throw new ConflictError("Die Abrechnung wartet nicht auf eine Freigabe");
    const step = r.approvals.find((a) => a.status === "PENDING");
    if (!step) throw new ConflictError("Kein offener Freigabeschritt");
    authorize(ctx, step.requiredPermission as Permission);
    const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
    if (me && me.id === r.employeeId) throw new ConflictError("Eigene Abrechnungen dürfen nicht selbst freigegeben werden");
    if (step.requiredPermission === "expense.approve" && !can(ctx, "expense.approve_all")) {
      const [emp] = await employeeBasics(tx, ctx.organizationId, [r.employeeId]);
      if (!me || emp?.managerId !== me.id) throw new ConflictError("Nur die direkte Führungskraft kann diese Stufe entscheiden");
    }
    if (input.decision === "REJECT" && (input.comment ?? "").trim().length < 3) throw new ConflictError("Bitte eine Begründung für die Ablehnung angeben");
    const approve = input.decision === "APPROVE";
    await tx.approval.update({ where: { id: step.id }, data: { status: approve ? "APPROVED" : "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), comment: input.comment ?? null } });
    const remaining = r.approvals.filter((a) => a.id !== step.id && a.status === "PENDING").length;
    const next: ExpenseStatus = !approve ? "REJECTED" : remaining === 0 ? "APPROVED" : "SUBMITTED";
    if (next !== "SUBMITTED") await tx.expenseReport.update({ where: { id: r.id }, data: { status: next, decidedAt: new Date() } });
    await writeAudit(tx, ctx, { action: approve ? "expense.approve_step" : "expense.reject", entityType: "ExpenseReport", entityId: r.id, after: { step: step.stepKey, status: next, comment: input.comment ?? null } });
    return { status: next };
  });
}

/** Auszahlung vermerken (Finanzen). Die Überweisung selbst erfolgt außerhalb; der Bankabgleich kennt Spesen nicht. */
export async function markExpensePaid(ctx: Ctx, raw: unknown) {
  authorize(ctx, "expense.pay");
  const input = paidInput.parse(raw);
  if (input.paidOn > todayIso()) throw new ConflictError("Das Auszahlungsdatum liegt in der Zukunft");
  return db.$transaction(async (tx) => {
    await lockReport(tx, ctx.organizationId, input.reportId);
    const r = await tx.expenseReport.findFirst({ where: { id: input.reportId, organizationId: ctx.organizationId } });
    if (!r) throw new NotFoundError("Spesenabrechnung");
    if (!canTransition(r.status as ExpenseStatus, "PAID")) throw new ConflictError("Nur freigegebene Abrechnungen können als ausbezahlt vermerkt werden");
    await tx.expenseReport.update({ where: { id: r.id }, data: { status: "PAID", paidOn: dateFromIso(input.paidOn), paidById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "expense.paid", entityType: "ExpenseReport", entityId: r.id, after: { paidOn: input.paidOn, total: r.totalAmount.toString() } });
  });
}

// ───────────────────────── Lesen ─────────────────────────

export type ExpenseScope = "mine" | "team" | "all";

export async function listExpenseReports(ctx: Ctx, scope: ExpenseScope) {
  let where: Prisma.ExpenseReportWhereInput = { organizationId: ctx.organizationId };
  if (scope === "all") authorize(ctx, "expense.read_all");
  else {
    authorize(ctx, scope === "team" ? "expense.approve" : "expense.submit");
    const me = await employeeByUser(db, ctx.organizationId, ctx.userId);
    if (!me) return [];
    if (scope === "mine") where = { ...where, employeeId: me.id };
    else {
      const reports = await db.employee.findMany({ where: { organizationId: ctx.organizationId, managerId: me.id }, select: { id: true } });
      where = { ...where, employeeId: { in: reports.map((e) => e.id) }, status: { not: "DRAFT" } }; // Entwürfe sieht nur die Person selbst
    }
  }
  const rows = await db.expenseReport.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  const names = new Map((await employeeBasics(db, ctx.organizationId, [...new Set(rows.map((r) => r.employeeId))])).map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  return rows.map((r) => ({ ...r, employeeName: names.get(r.employeeId) ?? "–" }));
}

export async function getExpenseReport(ctx: Ctx, id: string) {
  authorize(ctx, "expense.submit");
  const r = await db.expenseReport.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: { orderBy: { date: "asc" } }, approvals: { orderBy: { sequence: "asc" } } } });
  if (!r || !(await canSee(ctx, db, r))) throw new NotFoundError("Spesenabrechnung"); // fremde Abrechnungen sind nicht erkennbar
  const [emp] = await employeeBasics(db, ctx.organizationId, [r.employeeId]);
  const me = await employeeByUser(db, ctx.organizationId, ctx.userId);
  return { ...r, employeeName: emp ? `${emp.firstName} ${emp.lastName}` : "–", isOwn: me?.id === r.employeeId };
}

/** Offene Abrechnungen, die die Person jetzt entscheiden darf (nächster Schritt, Berechtigung, Teamzuordnung, nicht eigene). */
export async function listPendingExpenseApprovals(ctx: Ctx) {
  const mine = [...ctx.permissions];
  if (mine.length === 0) return [];
  const me = await employeeByUser(db, ctx.organizationId, ctx.userId);
  const pending = await db.approval.findMany({
    where: { organizationId: ctx.organizationId, status: "PENDING", requiredPermission: { in: mine }, expenseReport: { status: "SUBMITTED" } },
    include: { expenseReport: true }, orderBy: { sequence: "asc" },
  });
  const result = [];
  for (const a of pending) {
    const rep = a.expenseReport;
    if (!rep || !a.expenseReportId) continue;
    if (me && me.id === rep.employeeId) continue;
    const [emp] = await employeeBasics(db, ctx.organizationId, [rep.employeeId]);
    if (a.requiredPermission === "expense.approve" && !can(ctx, "expense.approve_all") && (!me || emp?.managerId !== me.id)) continue;
    const earlier = await db.approval.count({ where: { expenseReportId: a.expenseReportId, sequence: { lt: a.sequence }, status: { not: "APPROVED" } } });
    if (earlier === 0) result.push({ ...a, expenseReport: rep, employeeName: emp ? `${emp.firstName} ${emp.lastName}` : "–" });
  }
  return result;
}

/** Belegdatei einer Position (nur für Berechtigte der Abrechnung). */
export async function getExpenseReceipt(ctx: Ctx, lineId: string) {
  authorize(ctx, "expense.submit");
  const line = await db.expenseLine.findFirst({ where: { id: lineId, report: { organizationId: ctx.organizationId } }, include: { report: true } });
  if (!line || !line.receiptFileId || !(await canSee(ctx, db, line.report))) throw new NotFoundError("Beleg");
  return loadVerifiedFile(ctx, line.receiptFileId);
}
