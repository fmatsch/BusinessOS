import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { decimalString } from "@/lib/zod-decimal";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso, employeeByUser, employeesEmployedIn, isValidIsoDate } from "@/modules/hr/queries";
import { calculateEmployee, DEFAULT_PARAMS_AT, paramsSchema, PayrollLimitError, type PayrollParams } from "./calc";
import { csvField } from "./csv";

type Tx = Prisma.TransactionClient;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const money2 = (d: Decimal) => d.decimalPlaces() <= 2;
const amount = decimalString.refine((d) => d.gte(0) && money2(d), "Betrag ≥ 0 mit höchstens 2 Nachkommastellen");

// ───────────────────────── Parametersätze ─────────────────────────

const paramSetInput = z.object({
  label: z.string().trim().min(1).max(120),
  validFrom: z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)"),
  source: z.string().trim().min(1, "Quelle der Werte angeben").max(500),
  /** ohne Angabe: Entwurfswerte Österreich */
  params: z.unknown().optional(),
});

export async function listParamSets(ctx: Ctx) {
  authorize(ctx, "payroll.calc.read");
  return db.payrollParamSet.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { validFrom: "desc" } });
}

export async function createParamSet(ctx: Ctx, raw: unknown) {
  authorize(ctx, "payroll.params.manage");
  const input = paramSetInput.parse(raw);
  const params = paramsSchema.parse(input.params ?? DEFAULT_PARAMS_AT);
  return db.$transaction(async (tx) => {
    const created = await tx.payrollParamSet.create({
      data: { organizationId: ctx.organizationId, label: input.label, validFrom: dateFromIso(input.validFrom), params: params as unknown as Prisma.InputJsonValue, source: input.source, createdById: ctx.userId },
    });
    await writeAudit(tx, ctx, { action: "payroll_params.create", entityType: "PayrollParamSet", entityId: created.id, after: { label: input.label, validFrom: input.validFrom } });
    return created;
  });
}

/** Prüfung der Werte durch eine zweite Person (Vier-Augen). Erst danach ist eine Freigabe von Läufen mit diesem Satz möglich. */
export async function validateParamSet(ctx: Ctx, id: string) {
  authorize(ctx, "payroll.params.manage");
  return db.$transaction(async (tx) => {
    const set = await tx.payrollParamSet.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!set) throw new NotFoundError("Parametersatz");
    if (set.validatedAt) throw new ConflictError("Der Parametersatz ist bereits geprüft");
    if (set.createdById === ctx.userId) throw new ConflictError("Die Prüfung muss eine andere Person als die anlegende durchführen");
    await tx.payrollParamSet.update({ where: { id }, data: { validatedAt: new Date(), validatedById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "payroll_params.validate", entityType: "PayrollParamSet", entityId: id });
  });
}

// ───────────────────────── Vertragsdaten ─────────────────────────

const termsInput = z.object({
  employeeId: z.string().min(1),
  validFrom: z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)"),
  monthlyGross: amount,
  marginal: z.coerce.boolean().default(false),
  allowanceMonthly: amount.default("0" as never),
  commuterMonthly: amount.default("0" as never),
  familyBonusChildren: z.coerce.number().int().min(0).max(20).default(0),
});

/** Neue Vertragsdaten (Gehalt usw.) ab einem Datum. Alte Zeilen bleiben bestehen. Die Änderung wird protokolliert – ohne Beträge im Audit-Log. */
export async function setPayrollTerms(ctx: Ctx, raw: unknown) {
  authorize(ctx, "payroll.calc.manage");
  const input = termsInput.parse(raw);
  return db.$transaction(async (tx) => {
    const emp = await tx.employee.findFirst({ where: { id: input.employeeId, organizationId: ctx.organizationId }, select: { id: true } });
    if (!emp) throw new NotFoundError("Mitarbeiter");
    const dup = await tx.payrollTerms.findFirst({ where: { organizationId: ctx.organizationId, employeeId: emp.id, validFrom: dateFromIso(input.validFrom) } });
    if (dup) throw new ConflictError("Für dieses Datum existieren bereits Vertragsdaten – wählen Sie ein späteres Gültig-ab-Datum");
    const created = await tx.payrollTerms.create({
      data: {
        organizationId: ctx.organizationId, employeeId: emp.id, validFrom: dateFromIso(input.validFrom), monthlyGross: input.monthlyGross.toString(), marginal: input.marginal,
        allowanceMonthly: new Decimal(String(input.allowanceMonthly)).toString(), commuterMonthly: new Decimal(String(input.commuterMonthly)).toString(), familyBonusChildren: input.familyBonusChildren, createdById: ctx.userId,
      },
    });
    await writeAudit(tx, ctx, { action: "payroll_terms.set", entityType: "PayrollTerms", entityId: created.id, after: { employeeId: emp.id, validFrom: input.validFrom } });
    return created;
  });
}

/** Aktuelle Vertragsdaten je Mitarbeiter (Lesen wird protokolliert). */
export async function listPayrollTerms(ctx: Ctx) {
  authorize(ctx, "payroll.calc.read");
  return db.$transaction(async (tx) => {
    const rows = await tx.payrollTerms.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ employeeId: "asc" }, { validFrom: "desc" }] });
    const emps = await tx.employee.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...new Set(rows.map((r) => r.employeeId))] } }, select: { id: true, number: true, firstName: true, lastName: true } });
    await writeAudit(tx, ctx, { action: "payroll_terms.read", entityType: "PayrollTerms", entityId: ctx.organizationId, after: { count: rows.length } });
    const by = new Map(emps.map((e) => [e.id, e]));
    return rows.map((r) => ({ ...r, employee: by.get(r.employeeId)! }));
  });
}

// ───────────────────────── Lauf ─────────────────────────

const runInput = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  /** Einmalige Eingaben dieses Monats je Mitarbeiter */
  inputs: z.array(z.object({ employeeId: z.string().min(1), regularExtra: amount.default("0" as never), special: amount.default("0" as never) })).default([]),
});

async function computeLines(tx: Tx, ctx: Ctx, year: number, month: number, params: PayrollParams, inputs: z.infer<typeof runInput>["inputs"]) {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = iso(new Date(Date.UTC(year, month, 0)));
  const employees = await employeesEmployedIn(tx, ctx.organizationId, first, last);
  const allTerms = await tx.payrollTerms.findMany({ where: { organizationId: ctx.organizationId, employeeId: { in: employees.map((e) => e.id) }, validFrom: { lte: dateFromIso(last) } }, orderBy: { validFrom: "desc" } });
  const inputBy = new Map(inputs.map((i) => [i.employeeId, i]));
  for (const id of inputBy.keys()) if (!employees.some((e) => e.id === id)) throw new ConflictError("Eingabe für einen Mitarbeiter ohne Beschäftigung im Monat");
  const lines: Prisma.PayrollRunLineCreateManyInput[] = [];
  const missing: string[] = [];
  for (const e of employees) {
    const t = allTerms.find((x) => x.employeeId === e.id);
    if (!t) { missing.push(`${e.number} ${e.lastName}`); continue; }
    const inp = inputBy.get(e.id);
    const regularExtra = new Decimal(String(inp?.regularExtra ?? "0")), special = new Decimal(String(inp?.special ?? "0"));
    let r;
    try {
      r = calculateEmployee(params, {
        monthlyGross: new Decimal(t.monthlyGross.toString()), regularExtra, special, marginal: t.marginal,
        allowanceMonthly: new Decimal(t.allowanceMonthly.toString()), commuterMonthly: new Decimal(t.commuterMonthly.toString()), familyBonusChildren: t.familyBonusChildren,
      });
    } catch (err) {
      if (err instanceof PayrollLimitError) throw new ConflictError(`${e.number} ${e.lastName}: ${err.message}`);
      throw err;
    }
    lines.push({
      organizationId: ctx.organizationId, runId: "", employeeId: e.id, employeeNumber: e.number, employeeName: `${e.firstName} ${e.lastName}`,
      regularExtra: regularExtra.toString(), special: special.toString(), gross: r.gross, svEmployee: r.svEmployee, tax: r.tax, net: r.net, employerCost: r.employerCost,
      detail: r as unknown as Prisma.InputJsonValue,
    });
  }
  if (missing.length) throw new ConflictError(`Vertragsdaten für die Abrechnung fehlen: ${missing.join(", ")}`);
  if (lines.length === 0) throw new ConflictError("Keine Beschäftigten mit Vertragsdaten im Monat");
  return lines;
}

async function paramSetFor(tx: Tx, organizationId: string, year: number, month: number) {
  const last = new Date(Date.UTC(year, month, 0));
  const set = await tx.payrollParamSet.findFirst({ where: { organizationId, validFrom: { lte: last } }, orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }] });
  if (!set) throw new ConflictError("Kein Parametersatz für den Monat vorhanden – bitte zuerst anlegen und prüfen");
  return set;
}

/** Berechnet einen Lauf als Entwurf. Je Monat gibt es höchstens einen nicht stornierten Lauf. */
export async function createRun(ctx: Ctx, raw: unknown) {
  authorize(ctx, "payroll.calc.manage");
  const input = runInput.parse(raw);
  return db.$transaction(async (tx) => {
    const set = await paramSetFor(tx, ctx.organizationId, input.year, input.month);
    const params = paramsSchema.parse(set.params);
    const existing = await tx.payrollRun.findFirst({ where: { organizationId: ctx.organizationId, year: input.year, month: input.month, status: { not: "CANCELLED" } } });
    if (existing) throw new ConflictError("Für diesen Monat gibt es bereits einen Lauf – stornieren Sie ihn, um neu zu rechnen");
    const version = ((await tx.payrollRun.aggregate({ where: { organizationId: ctx.organizationId, year: input.year, month: input.month }, _max: { version: true } }))._max.version ?? 0) + 1;
    const run = await tx.payrollRun.create({
      data: { organizationId: ctx.organizationId, year: input.year, month: input.month, version, paramSetId: set.id, paramsSnapshot: params as unknown as Prisma.InputJsonValue, paramsValidated: !!set.validatedAt, createdById: ctx.userId },
    });
    const lines = await computeLines(tx, ctx, input.year, input.month, params, input.inputs);
    await tx.payrollRunLine.createMany({ data: lines.map((l) => ({ ...l, runId: run.id })) });
    await writeAudit(tx, ctx, { action: "payroll_run.create", entityType: "PayrollRun", entityId: run.id, after: { year: input.year, month: input.month, version, employees: lines.length } });
    return run;
  });
}

/** Entwurf mit geänderten Eingaben oder Vertragsdaten neu berechnen. */
export async function recalcRun(ctx: Ctx, runId: string, raw: unknown) {
  authorize(ctx, "payroll.calc.manage");
  const input = runInput.pick({ inputs: true }).parse(raw);
  return db.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, organizationId: ctx.organizationId } });
    if (!run) throw new NotFoundError("Abrechnungslauf");
    if (run.status !== "DRAFT") throw new ConflictError("Nur Entwürfe können neu berechnet werden");
    const set = await paramSetFor(tx, ctx.organizationId, run.year, run.month);
    const params = paramsSchema.parse(set.params);
    const lines = await computeLines(tx, ctx, run.year, run.month, params, input.inputs);
    await tx.payrollRunLine.deleteMany({ where: { runId } });
    await tx.payrollRunLine.createMany({ data: lines.map((l) => ({ ...l, runId })) });
    await tx.payrollRun.update({ where: { id: runId }, data: { paramSetId: set.id, paramsSnapshot: params as unknown as Prisma.InputJsonValue, paramsValidated: !!set.validatedAt } });
    await writeAudit(tx, ctx, { action: "payroll_run.recalc", entityType: "PayrollRun", entityId: runId, after: { employees: lines.length } });
  });
}

/** Freigabe: nur mit geprüftem Parametersatz und durch eine andere Person als die erstellende. */
export async function approveRun(ctx: Ctx, runId: string) {
  authorize(ctx, "payroll.calc.approve");
  return db.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, organizationId: ctx.organizationId } });
    if (!run) throw new NotFoundError("Abrechnungslauf");
    if (run.status !== "DRAFT") throw new ConflictError("Der Lauf ist nicht im Entwurf");
    if (run.createdById === ctx.userId) throw new ConflictError("Den eigenen Lauf können Sie nicht freigeben (Vier-Augen-Prinzip)");
    const set = await tx.payrollParamSet.findFirst({ where: { id: run.paramSetId, organizationId: ctx.organizationId } });
    if (!set?.validatedAt) throw new ConflictError("Der Parametersatz ist noch nicht geprüft – Freigabe nicht möglich");
    const r = await tx.payrollRun.updateMany({ where: { id: runId, status: "DRAFT" }, data: { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date(), paramsValidated: true } });
    if (r.count !== 1) throw new ConflictError("Der Lauf wurde gleichzeitig geändert");
    await writeAudit(tx, ctx, { action: "payroll_run.approve", entityType: "PayrollRun", entityId: runId });
  });
}

/** Storno eines freigegebenen Laufs (Begründung Pflicht). Danach kann der Monat neu gerechnet werden (neue Version). */
export async function cancelRun(ctx: Ctx, runId: string, reason: string) {
  authorize(ctx, "payroll.calc.approve");
  const why = z.string().trim().min(3, "Begründung angeben").max(500).parse(reason);
  return db.$transaction(async (tx) => {
    const r = await tx.payrollRun.updateMany({ where: { id: runId, organizationId: ctx.organizationId, status: "APPROVED" }, data: { status: "CANCELLED", cancelledById: ctx.userId, cancelledAt: new Date(), cancelReason: why } });
    if (r.count !== 1) throw new ConflictError("Nur freigegebene Läufe können storniert werden");
    await writeAudit(tx, ctx, { action: "payroll_run.cancel", entityType: "PayrollRun", entityId: runId, after: { reason: why } });
  });
}

/** Entwurf verwerfen (nur Entwürfe). */
export async function discardRun(ctx: Ctx, runId: string) {
  authorize(ctx, "payroll.calc.manage");
  return db.$transaction(async (tx) => {
    const run = await tx.payrollRun.findFirst({ where: { id: runId, organizationId: ctx.organizationId, status: "DRAFT" } });
    if (!run) throw new ConflictError("Nur Entwürfe können verworfen werden");
    await tx.payrollRunLine.deleteMany({ where: { runId } });
    await tx.payrollRun.delete({ where: { id: runId } });
    await writeAudit(tx, ctx, { action: "payroll_run.discard", entityType: "PayrollRun", entityId: runId });
  });
}

export async function listRuns(ctx: Ctx) {
  authorize(ctx, "payroll.calc.read");
  return db.payrollRun.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ year: "desc" }, { month: "desc" }, { version: "desc" }], include: { _count: { select: { lines: true } } } });
}

/** Lauf mit allen Zeilen und Summen (Zugriff wird protokolliert). */
export async function getRun(ctx: Ctx, runId: string) {
  authorize(ctx, "payroll.calc.read");
  return db.$transaction(async (tx) => {
    const found = await tx.payrollRun.findFirst({ where: { id: runId, organizationId: ctx.organizationId }, include: { lines: { orderBy: { employeeNumber: "asc" } } } });
    if (!found) throw new NotFoundError("Abrechnungslauf");
    const run = found;
    const lines = run.lines;
    await writeAudit(tx, ctx, { action: "payroll_run.read", entityType: "PayrollRun", entityId: runId });
    const sum = (f: (l: (typeof lines)[number]) => Prisma.Decimal) => lines.reduce((s, l) => s.plus(f(l).toString()), new Decimal(0));
    return { ...run, totals: { gross: sum((l) => l.gross), svEmployee: sum((l) => l.svEmployee), tax: sum((l) => l.tax), net: sum((l) => l.net), employerCost: sum((l) => l.employerCost) } };
  });
}

/** CSV der Abrechnung (Nettoauszahlung, für Bank/Steuerberatung). Zahlenfelder ungeschützt, Textfelder formelgeschützt. */
export async function runCsv(ctx: Ctx, runId: string) {
  const run = await getRun(ctx, runId);
  if (run.status !== "APPROVED") throw new ConflictError("Nur freigegebene Läufe können exportiert werden");
  const d = ";";
  const num = (v: Prisma.Decimal) => v.toFixed(2).replace(".", ",");
  const rows = [["Personalnummer", "Name", "Brutto", "SV Arbeitnehmer", "Lohnsteuer", "Netto", "Arbeitgeberkosten"].join(d)];
  for (const l of run.lines) rows.push([csvField(l.employeeNumber, d), csvField(l.employeeName, d), num(l.gross), num(l.svEmployee), num(l.tax), num(l.net), num(l.employerCost)].join(d));
  return { fileName: `Lohnabrechnung-${run.year}-${String(run.month).padStart(2, "0")}-v${run.version}.csv`, content: "﻿" + rows.join("\r\n") + "\r\n" };
}

// ───────────────────────── Eigene Abrechnung ─────────────────────────

/** Eigene Lohnabrechnungen (nur freigegebene Läufe, nur die eigene Zeile). */
export async function myPayslips(ctx: Ctx) {
  authorize(ctx, "payroll.payslip.own");
  const emp = await employeeByUser(db, ctx.organizationId, ctx.userId);
  if (!emp) return [];
  return db.payrollRunLine.findMany({
    where: { organizationId: ctx.organizationId, employeeId: emp.id, run: { status: "APPROVED" } },
    orderBy: [{ run: { year: "desc" } }, { run: { month: "desc" } }],
    include: { run: { select: { year: true, month: true, version: true } } },
  });
}

export async function myPayslip(ctx: Ctx, lineId: string) {
  authorize(ctx, "payroll.payslip.own");
  const emp = await employeeByUser(db, ctx.organizationId, ctx.userId);
  if (!emp) throw new NotFoundError("Abrechnung");
  const line = await db.payrollRunLine.findFirst({ where: { id: lineId, organizationId: ctx.organizationId, employeeId: emp.id, run: { status: "APPROVED" } }, include: { run: { select: { year: true, month: true, version: true } } } });
  if (!line) throw new NotFoundError("Abrechnung");
  return line;
}
