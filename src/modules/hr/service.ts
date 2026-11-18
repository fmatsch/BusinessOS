import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, can, ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import type { Permission } from "@/platform/authz/permissions";
import { writeAudit } from "@/platform/audit/audit";
import { stepsFor } from "@/platform/approvals/engine";
import { ABSENCE_REQUEST, getActivePolicy } from "@/platform/approvals/policy";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { absenceDecisionInput, absenceInput, employeeInput, employeeUpdateInput, employmentInput, leaveEntryInput, sensitiveInput } from "./schema";
import { countWorkingDays, dateFromIso, daysBetween, isoFromDate, rangesOverlap, workingDaysByYear } from "./calendar";

type Tx = Prisma.TransactionClient;

async function emit(tx: Tx, ctx: Ctx, type: string, payload: Prisma.InputJsonValue) {
  await tx.outboxEvent.create({ data: { organizationId: ctx.organizationId, type, payload } });
}

/** Mitarbeiterprofil des angemeldeten Benutzers in der aktiven Organisation. */
export async function getSelfEmployee(ctx: Pick<Ctx, "userId" | "organizationId">, tx: Tx | typeof db = db) {
  return tx.employee.findFirst({ where: { organizationId: ctx.organizationId, userId: ctx.userId } });
}

const isSelf = (ctx: Ctx, e: { userId: string | null }) => e.userId !== null && e.userId === ctx.userId;

/** Zeilensperre auf den Mitarbeiter: serialisiert Anträge, Freigaben und Stornos je Person (verhindert Überbuchung des Urlaubs). */
async function lockEmployee(tx: Tx, organizationId: string, employeeId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Mitarbeiter");
}

// ───────────────────────── Mitarbeiter ─────────────────────────

const BASIC = { id: true, number: true, firstName: true, lastName: true, email: true, jobTitle: true, active: true, userId: true, managerId: true } as const;

export async function listEmployees(ctx: Ctx) {
  authorize(ctx, "hr.employee.read");
  return db.employee.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: { ...BASIC, department: { select: { name: true } }, manager: { select: { firstName: true, lastName: true } } },
  });
}

export async function getEmployee(ctx: Ctx, id: string) {
  const e = await db.employee.findFirst({
    where: { id, organizationId: ctx.organizationId },
    select: { ...BASIC, departmentId: true, department: { select: { name: true } }, manager: { select: { id: true, firstName: true, lastName: true } } },
  });
  if (!e) throw new NotFoundError("Mitarbeiter");
  if (!can(ctx, "hr.employee.read") && !isSelf(ctx, e)) throw new ForbiddenError("hr.employee.read");
  return e;
}

async function assertManagerValid(tx: Tx, organizationId: string, employeeId: string | null, managerId: string) {
  const manager = await tx.employee.findFirst({ where: { id: managerId, organizationId }, select: { id: true, managerId: true } });
  if (!manager) throw new NotFoundError("Führungskraft");
  if (employeeId === null) return;
  // Zyklen verhindern: die Kette der Führungskräfte darf den Mitarbeiter nicht enthalten
  let cursor: string | null = manager.id;
  for (let i = 0; i < 100 && cursor; i++) {
    if (cursor === employeeId) throw new ConflictError("Die Führungskraft würde einen Zyklus in der Hierarchie erzeugen");
    const next: { managerId: string | null } | null = await tx.employee.findFirst({ where: { id: cursor, organizationId }, select: { managerId: true } });
    cursor = next?.managerId ?? null;
  }
}

async function assertRefs(tx: Tx, ctx: Ctx, input: { departmentId?: string | null; userId?: string | null }) {
  if (input.departmentId && !(await tx.department.findFirst({ where: { id: input.departmentId, organizationId: ctx.organizationId }, select: { id: true } })))
    throw new NotFoundError("Abteilung");
  if (input.userId && !(await tx.organizationMembership.findFirst({ where: { userId: input.userId, organizationId: ctx.organizationId }, select: { id: true } })))
    throw new NotFoundError("Benutzer");
}

export async function createEmployee(ctx: Ctx, raw: unknown) {
  authorize(ctx, "hr.employee.write");
  const input = employeeInput.parse(raw);
  return db.$transaction(async (tx) => {
    await assertRefs(tx, ctx, input);
    if (input.managerId) await assertManagerValid(tx, ctx.organizationId, null, input.managerId);
    const created = await tx.employee.create({
      data: {
        organizationId: ctx.organizationId, number: input.number, firstName: input.firstName, lastName: input.lastName,
        email: input.email ?? null, jobTitle: input.jobTitle ?? null, departmentId: input.departmentId ?? null,
        managerId: input.managerId ?? null, userId: input.userId ?? null,
      },
    });
    await writeAudit(tx, ctx, {
      action: "employee.create", entityType: "Employee", entityId: created.id,
      after: { number: created.number, departmentId: created.departmentId, managerId: created.managerId },
    });
    return created;
  });
}

export async function updateEmployee(ctx: Ctx, id: string, raw: unknown) {
  authorize(ctx, "hr.employee.write");
  const input = employeeUpdateInput.parse(raw);
  return db.$transaction(async (tx) => {
    const before = await tx.employee.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new NotFoundError("Mitarbeiter");
    await assertRefs(tx, ctx, input);
    if (input.managerId) await assertManagerValid(tx, ctx.organizationId, id, input.managerId);
    const updated = await tx.employee.update({
      where: { id },
      data: {
        firstName: input.firstName, lastName: input.lastName, email: input.email ?? null, jobTitle: input.jobTitle ?? null,
        departmentId: input.departmentId ?? null, managerId: input.managerId ?? null, userId: input.userId ?? null,
        ...(input.active === undefined ? {} : { active: input.active }),
      },
    });
    await writeAudit(tx, ctx, {
      action: "employee.update", entityType: "Employee", entityId: id,
      before: { departmentId: before.departmentId, managerId: before.managerId, active: before.active, userId: before.userId },
      after: { departmentId: updated.departmentId, managerId: updated.managerId, active: updated.active, userId: updated.userId },
    });
    return updated;
  });
}

// ───────────────────── Sensible Daten (getrennt, protokolliert) ─────────────────────

/** Lesen ist nur mit Sonderrecht (oder für die eigene Person) möglich und wird im Audit-Log festgehalten. */
export async function readSensitive(ctx: Ctx, employeeId: string) {
  return db.$transaction(async (tx) => {
    const e = await tx.employee.findFirst({ where: { id: employeeId, organizationId: ctx.organizationId }, select: { id: true, userId: true } });
    if (!e) throw new NotFoundError("Mitarbeiter");
    if (!can(ctx, "hr.employee.read_sensitive") && !isSelf(ctx, e)) throw new ForbiddenError("hr.employee.read_sensitive");
    const s = await tx.employeeSensitive.findFirst({ where: { employeeId, organizationId: ctx.organizationId } });
    await writeAudit(tx, ctx, { action: "employee.read_sensitive", entityType: "Employee", entityId: employeeId });
    return {
      birthDate: s?.birthDate ? isoFromDate(s.birthDate) : null,
      addressLine: s?.addressLine ?? null, phone: s?.phone ?? null, emergencyContact: s?.emergencyContact ?? null,
    };
  });
}

export async function writeSensitive(ctx: Ctx, employeeId: string, raw: unknown) {
  authorize(ctx, "hr.employee.write_sensitive");
  const input = sensitiveInput.parse(raw);
  return db.$transaction(async (tx) => {
    const e = await tx.employee.findFirst({ where: { id: employeeId, organizationId: ctx.organizationId }, select: { id: true } });
    if (!e) throw new NotFoundError("Mitarbeiter");
    const data = {
      birthDate: input.birthDate ? dateFromIso(input.birthDate) : null,
      addressLine: input.addressLine ?? null, phone: input.phone ?? null, emergencyContact: input.emergencyContact ?? null,
    };
    await tx.employeeSensitive.upsert({
      where: { employeeId }, create: { employeeId, organizationId: ctx.organizationId, ...data }, update: data,
    });
    // Inhalte werden bewusst nicht ins Audit-Log kopiert – nur dass und welche Felder geändert wurden
    await writeAudit(tx, ctx, { action: "employee.write_sensitive", entityType: "Employee", entityId: employeeId, after: { fields: Object.keys(input) } });
  });
}

// ───────────────────────── Beschäftigung ─────────────────────────

export async function listEmployments(ctx: Ctx, employeeId: string) {
  const e = await db.employee.findFirst({ where: { id: employeeId, organizationId: ctx.organizationId }, select: { id: true, userId: true } });
  if (!e) throw new NotFoundError("Mitarbeiter");
  if (!can(ctx, "hr.employment.read") && !isSelf(ctx, e)) throw new ForbiddenError("hr.employment.read");
  return db.employment.findMany({
    where: { employeeId, organizationId: ctx.organizationId }, orderBy: { validFrom: "desc" },
    include: { costCenter: { select: { code: true, name: true } } },
  });
}

export async function addEmployment(ctx: Ctx, raw: unknown) {
  authorize(ctx, "hr.employment.write");
  const input = employmentInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockEmployee(tx, ctx.organizationId, input.employeeId);
    if (input.costCenterId && !(await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId }, select: { id: true } })))
      throw new NotFoundError("Kostenstelle");
    const existing = await tx.employment.findMany({ where: { employeeId: input.employeeId, organizationId: ctx.organizationId } });
    for (const x of existing) {
      if (rangesOverlap(input.validFrom, input.validTo ?? "9999-12-31", isoFromDate(x.validFrom), x.validTo ? isoFromDate(x.validTo) : null))
        throw new ConflictError("Der Zeitraum überschneidet sich mit einem bestehenden Beschäftigungsverhältnis");
    }
    const created = await tx.employment.create({
      data: {
        organizationId: ctx.organizationId, employeeId: input.employeeId, validFrom: dateFromIso(input.validFrom),
        validTo: input.validTo ? dateFromIso(input.validTo) : null, contractType: input.contractType,
        weeklyHours: input.weeklyHours, costCenterId: input.costCenterId ?? null,
      },
    });
    await writeAudit(tx, ctx, {
      action: "employment.add", entityType: "Employment", entityId: created.id,
      after: { employeeId: input.employeeId, validFrom: input.validFrom, validTo: input.validTo ?? null, contractType: input.contractType, weeklyHours: input.weeklyHours.toString() },
    });
    return created;
  });
}

/** Beendet ein offenes Beschäftigungsverhältnis. */
export async function closeEmployment(ctx: Ctx, employmentId: string, validTo: string) {
  authorize(ctx, "hr.employment.write");
  return db.$transaction(async (tx) => {
    const e = await tx.employment.findFirst({ where: { id: employmentId, organizationId: ctx.organizationId } });
    if (!e) throw new NotFoundError("Beschäftigungsverhältnis");
    await lockEmployee(tx, ctx.organizationId, e.employeeId);
    if (e.validTo) throw new ConflictError("Das Beschäftigungsverhältnis ist bereits beendet");
    if (validTo < isoFromDate(e.validFrom)) throw new ConflictError("Das Ende darf nicht vor dem Beginn liegen");
    await tx.employment.update({ where: { id: e.id }, data: { validTo: dateFromIso(validTo) } });
    await writeAudit(tx, ctx, { action: "employment.close", entityType: "Employment", entityId: e.id, after: { validTo } });
  });
}

// ───────────────────────── Urlaubskonto (Journal) ─────────────────────────

async function canSeeEmployeeLeave(ctx: Ctx, e: { id: string; userId: string | null; managerId: string | null }) {
  if (isSelf(ctx, e) || can(ctx, "hr.leave.write") || can(ctx, "hr.absence.read_all")) return true;
  if (can(ctx, "hr.absence.approve")) {
    const me = await getSelfEmployee(ctx);
    return !!me && e.managerId === me.id;
  }
  return false;
}

export interface LeaveBalance {
  year: number;
  entitlement: Decimal; // Anspruch + Übertrag + Korrekturen
  taken: Decimal; // genommen (positiv)
  reserved: Decimal; // beantragt, noch nicht freigegeben
  remaining: Decimal; // Saldo laut Journal
  available: Decimal; // Saldo minus Reserviertes
}

async function computeBalance(tx: Tx | typeof db, organizationId: string, employeeId: string, year: number): Promise<LeaveBalance> {
  const entries = await tx.leaveBalanceEntry.findMany({ where: { organizationId, employeeId, year } });
  let entitlement = new Decimal(0), taken = new Decimal(0);
  for (const e of entries) {
    const d = new Decimal(e.days.toString());
    if (e.kind === "TAKEN" || e.kind === "REVERSAL") taken = taken.minus(d); // TAKEN ist negativ, REVERSAL positiv
    else entitlement = entitlement.plus(d);
  }
  const pending = await tx.absenceRequest.findMany({
    where: { organizationId, employeeId, status: "PENDING", type: { deductsLeave: true } },
    select: { startDate: true, endDate: true },
  });
  let reserved = new Decimal(0);
  for (const p of pending) reserved = reserved.plus(workingDaysByYear(isoFromDate(p.startDate), isoFromDate(p.endDate)).get(year) ?? 0);
  const remaining = entitlement.minus(taken);
  return { year, entitlement, taken, reserved, remaining, available: remaining.minus(reserved) };
}

export async function leaveBalance(ctx: Ctx, employeeId: string, year: number): Promise<LeaveBalance> {
  const e = await db.employee.findFirst({ where: { id: employeeId, organizationId: ctx.organizationId }, select: { id: true, userId: true, managerId: true } });
  if (!e) throw new NotFoundError("Mitarbeiter");
  if (!(await canSeeEmployeeLeave(ctx, e))) throw new ForbiddenError("hr.leave.write");
  return computeBalance(db, ctx.organizationId, employeeId, year);
}

export async function listLeaveEntries(ctx: Ctx, employeeId: string, year: number) {
  const e = await db.employee.findFirst({ where: { id: employeeId, organizationId: ctx.organizationId }, select: { id: true, userId: true, managerId: true } });
  if (!e) throw new NotFoundError("Mitarbeiter");
  if (!(await canSeeEmployeeLeave(ctx, e))) throw new ForbiddenError("hr.leave.write");
  return db.leaveBalanceEntry.findMany({ where: { organizationId: ctx.organizationId, employeeId, year }, orderBy: { createdAt: "asc" } });
}

/** Anspruch, Übertrag oder Korrektur buchen (nur Personal). Einträge sind unveränderlich; Fehler werden mit Gegenbuchung korrigiert. */
export async function addLeaveEntry(ctx: Ctx, raw: unknown) {
  authorize(ctx, "hr.leave.write");
  const input = leaveEntryInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockEmployee(tx, ctx.organizationId, input.employeeId);
    const created = await tx.leaveBalanceEntry.create({
      data: {
        organizationId: ctx.organizationId, employeeId: input.employeeId, year: input.year, kind: input.kind,
        days: input.days, note: input.note ?? null, createdById: ctx.userId,
      },
    });
    await writeAudit(tx, ctx, {
      action: "leave.entry", entityType: "LeaveBalanceEntry", entityId: created.id,
      after: { employeeId: input.employeeId, year: input.year, kind: input.kind, days: input.days.toString() },
    });
    return created;
  });
}

// ───────────────────────── Abwesenheiten ─────────────────────────

const DEFAULT_TYPES = [
  { key: "VACATION", name: "Urlaub", deductsLeave: true, requiresApproval: true },
  { key: "SICK", name: "Krankenstand", deductsLeave: false, requiresApproval: false },
  { key: "CARE", name: "Pflegefreistellung", deductsLeave: false, requiresApproval: true },
  { key: "SPECIAL", name: "Sonderurlaub", deductsLeave: false, requiresApproval: true },
];

async function ensureTypes(tx: Tx | typeof db, organizationId: string) {
  await tx.absenceType.createMany({ data: DEFAULT_TYPES.map((t) => ({ ...t, organizationId })), skipDuplicates: true });
}

export async function listAbsenceTypes(ctx: Ctx) {
  await ensureTypes(db, ctx.organizationId);
  const types = await db.absenceType.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" } });
  return types.sort((a, b) => Number(b.key === "VACATION") - Number(a.key === "VACATION")); // Urlaub zuerst (häufigster Fall)
}

export async function requestAbsence(ctx: Ctx, raw: unknown) {
  authorize(ctx, "hr.absence.request");
  const input = absenceInput.parse(raw);
  if (daysBetween(input.startDate, input.endDate) > 366) throw new ConflictError("Der Zeitraum darf höchstens 366 Tage umfassen");
  const days = countWorkingDays(input.startDate, input.endDate);
  if (days === 0) throw new ConflictError("Der Zeitraum enthält keine Arbeitstage");

  return db.$transaction(async (tx) => {
    const me = await getSelfEmployee(ctx, tx);
    if (!me || !me.active) throw new ConflictError("Ihrem Benutzerkonto ist kein aktives Mitarbeiterprofil zugeordnet");
    await lockEmployee(tx, ctx.organizationId, me.id);
    await ensureTypes(tx, ctx.organizationId);
    const type = await tx.absenceType.findFirst({ where: { organizationId: ctx.organizationId, key: input.typeKey } });
    if (!type) throw new NotFoundError("Abwesenheitsart");

    // Überschneidung mit offenen oder genehmigten Anträgen
    const others = await tx.absenceRequest.findMany({
      where: { organizationId: ctx.organizationId, employeeId: me.id, status: { in: ["PENDING", "APPROVED"] } },
      select: { startDate: true, endDate: true },
    });
    if (others.some((o) => rangesOverlap(input.startDate, input.endDate, isoFromDate(o.startDate), isoFromDate(o.endDate))))
      throw new ConflictError("Der Zeitraum überschneidet sich mit einer bestehenden Abwesenheit");

    // Urlaubsguthaben je Kalenderjahr prüfen
    if (type.deductsLeave) {
      for (const [year, needed] of workingDaysByYear(input.startDate, input.endDate)) {
        const b = await computeBalance(tx, ctx.organizationId, me.id, year);
        if (b.available.lt(needed)) throw new ConflictError(`Resturlaub reicht nicht: ${year} verfügbar ${b.available.toString()} Tage, benötigt ${needed}`);
      }
    }

    const policy = await getActivePolicy(tx, ctx.organizationId, ABSENCE_REQUEST);
    const steps = type.requiresApproval ? stepsFor(policy.steps, days) : [];
    const created = await tx.absenceRequest.create({
      data: {
        organizationId: ctx.organizationId, employeeId: me.id, typeId: type.id,
        startDate: dateFromIso(input.startDate), endDate: dateFromIso(input.endDate), days,
        status: steps.length > 0 ? "PENDING" : "APPROVED", note: input.note ?? null, policyVersion: policy.version,
        approvals: {
          create: steps.map((s, i) => ({ organizationId: ctx.organizationId, stepKey: s.key, label: s.label, requiredPermission: s.permission, sequence: i + 1 })),
        },
      },
    });
    await writeAudit(tx, ctx, {
      action: steps.length > 0 ? "absence.request" : "absence.record", entityType: "AbsenceRequest", entityId: created.id,
      after: { employeeId: me.id, type: type.key, from: input.startDate, to: input.endDate, days: String(days) },
    });
    await emit(tx, ctx, steps.length > 0 ? "absence.requested" : "absence.recorded", { absenceId: created.id });
    return created;
  });
}

function takenEntries(from: string, to: string) {
  return [...workingDaysByYear(from, to)].map(([year, d]) => ({ year, days: d }));
}

export async function decideAbsence(ctx: Ctx, raw: unknown) {
  const input = absenceDecisionInput.parse(raw);
  return db.$transaction(async (tx) => {
    const found = await tx.absenceRequest.findFirst({ where: { id: input.absenceId, organizationId: ctx.organizationId }, select: { employeeId: true } });
    if (!found) throw new NotFoundError("Abwesenheitsantrag");
    await lockEmployee(tx, ctx.organizationId, found.employeeId);

    const absence = await tx.absenceRequest.findFirstOrThrow({
      where: { id: input.absenceId, organizationId: ctx.organizationId },
      include: { employee: true, type: true, approvals: { orderBy: { sequence: "asc" } } },
    });
    if (absence.status !== "PENDING") throw new ConflictError("Der Antrag ist nicht mehr offen");
    const step = absence.approvals.find((a) => a.status === "PENDING");
    if (!step) throw new ConflictError("Kein offener Freigabeschritt");
    authorize(ctx, step.requiredPermission as Permission);
    if (isSelf(ctx, absence.employee)) throw new ConflictError("Eigene Anträge dürfen nicht selbst entschieden werden");
    if (step.requiredPermission === "hr.absence.approve" && !can(ctx, "hr.absence.approve_all")) {
      const me = await getSelfEmployee(ctx, tx);
      if (!me || absence.employee.managerId !== me.id) throw new ForbiddenError("hr.absence.approve");
    }

    const claimed = await tx.approval.updateMany({
      where: { id: step.id, status: "PENDING" },
      data: { status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), comment: input.comment ?? null },
    });
    if (claimed.count !== 1) throw new ConflictError("Schritt wurde bereits entschieden");

    const remaining = absence.approvals.filter((a) => a.id !== step.id && a.status === "PENDING").length;
    const status = input.decision === "REJECT" ? "REJECTED" : remaining === 0 ? "APPROVED" : "PENDING";

    if (status === "APPROVED" && absence.type.deductsLeave) {
      const from = isoFromDate(absence.startDate), to = isoFromDate(absence.endDate);
      for (const t of takenEntries(from, to)) {
        // Saldo ohne die eigene Reservierung prüfen (die Reservierung wird gleich durch die Buchung ersetzt)
        const b = await computeBalance(tx, ctx.organizationId, absence.employeeId, t.year);
        if (b.remaining.lt(t.days)) throw new ConflictError(`Resturlaub reicht nicht mehr: ${t.year} Saldo ${b.remaining.toString()} Tage, benötigt ${t.days}`);
        await tx.leaveBalanceEntry.create({
          data: { organizationId: ctx.organizationId, employeeId: absence.employeeId, year: t.year, kind: "TAKEN", days: new Decimal(t.days).negated(), absenceRequestId: absence.id, createdById: ctx.userId },
        });
      }
    }
    if (status !== "PENDING" || input.decision === "REJECT") {
      await tx.absenceRequest.update({ where: { id: absence.id }, data: { status } });
    }
    await writeAudit(tx, ctx, {
      action: `absence.${input.decision === "APPROVE" ? "approve_step" : "reject"}`, entityType: "AbsenceRequest", entityId: absence.id,
      after: { step: step.stepKey, resulting: status, comment: input.comment ?? null },
    });
    await emit(tx, ctx, status === "PENDING" ? "absence.step_approved" : `absence.${status.toLowerCase()}`, { absenceId: absence.id });
    return { status };
  });
}

/** Stornieren: eigener Antrag (offen, oder genehmigt und noch nicht begonnen) oder durch Personal. Genehmigter Urlaub wird per Gegenbuchung zurückgegeben. */
export async function cancelAbsence(ctx: Ctx, absenceId: string) {
  return db.$transaction(async (tx) => {
    const found = await tx.absenceRequest.findFirst({ where: { id: absenceId, organizationId: ctx.organizationId }, select: { employeeId: true } });
    if (!found) throw new NotFoundError("Abwesenheitsantrag");
    await lockEmployee(tx, ctx.organizationId, found.employeeId);
    const absence = await tx.absenceRequest.findFirstOrThrow({
      where: { id: absenceId, organizationId: ctx.organizationId }, include: { employee: true, type: true, leaveEntries: true },
    });
    const hr = can(ctx, "hr.absence.approve_all");
    if (!hr && !isSelf(ctx, absence.employee)) throw new ForbiddenError("hr.absence.approve_all");
    if (absence.status !== "PENDING" && absence.status !== "APPROVED") throw new ConflictError("Der Antrag kann nicht mehr storniert werden");
    const today = new Date().toISOString().slice(0, 10);
    if (!hr && absence.status === "APPROVED" && isoFromDate(absence.startDate) <= today)
      throw new ConflictError("Begonnene Abwesenheiten kann nur das Personalwesen stornieren");

    if (absence.status === "APPROVED" && absence.type.deductsLeave) {
      // Gegenbuchung je ursprünglicher Buchung (Journal bleibt unverändert)
      for (const e of absence.leaveEntries.filter((x) => x.kind === "TAKEN")) {
        await tx.leaveBalanceEntry.create({
          data: { organizationId: ctx.organizationId, employeeId: absence.employeeId, year: e.year, kind: "REVERSAL", days: new Decimal(e.days.toString()).negated(), absenceRequestId: absence.id, createdById: ctx.userId, note: "Storno" },
        });
      }
    }
    await tx.absenceRequest.update({ where: { id: absence.id }, data: { status: "CANCELLED" } });
    await writeAudit(tx, ctx, { action: "absence.cancel", entityType: "AbsenceRequest", entityId: absence.id, before: { status: absence.status }, after: { status: "CANCELLED" } });
    await emit(tx, ctx, "absence.cancelled", { absenceId: absence.id, previousStatus: absence.status });
  });
}

export type AbsenceScope = "mine" | "team" | "all";

export async function listAbsences(ctx: Ctx, scope: AbsenceScope) {
  let where: Prisma.AbsenceRequestWhereInput = { organizationId: ctx.organizationId };
  if (scope === "all") authorize(ctx, "hr.absence.read_all");
  else if (scope === "team") authorize(ctx, "hr.absence.approve");
  if (scope !== "all") {
    const me = await getSelfEmployee(ctx);
    if (!me) return [];
    if (scope === "mine") where = { ...where, employeeId: me.id };
    else where = { ...where, employee: { managerId: me.id } };
  }
  return db.absenceRequest.findMany({
    where, orderBy: { startDate: "desc" }, take: 200,
    include: { employee: { select: { firstName: true, lastName: true } }, type: { select: { key: true, name: true } }, approvals: { orderBy: { sequence: "asc" } } },
  });
}

/** Offene Anträge, die der Benutzer jetzt entscheiden darf (nächster Schritt, Berechtigung, Team-Zuordnung, nicht eigene). */
export async function listPendingAbsenceApprovals(ctx: Ctx) {
  const mine = [...ctx.permissions];
  if (mine.length === 0) return [];
  const me = await getSelfEmployee(ctx);
  const pending = await db.approval.findMany({
    where: {
      organizationId: ctx.organizationId, status: "PENDING", requiredPermission: { in: mine },
      absenceRequest: { status: "PENDING" },
    },
    include: { absenceRequest: { include: { employee: true, type: true } } },
    orderBy: { sequence: "asc" },
  });
  const result = [];
  for (const a of pending) {
    const abs = a.absenceRequest;
    if (!abs || !a.absenceRequestId) continue;
    if (isSelf(ctx, abs.employee)) continue;
    if (a.requiredPermission === "hr.absence.approve" && !can(ctx, "hr.absence.approve_all") && (!me || abs.employee.managerId !== me.id)) continue;
    const earlier = await db.approval.count({ where: { absenceRequestId: a.absenceRequestId, sequence: { lt: a.sequence }, status: { not: "APPROVED" } } });
    if (earlier === 0) result.push({ ...a, absenceRequest: abs });
  }
  return result;
}

/** Benutzer der Organisation, die noch keinem Mitarbeiterprofil zugeordnet sind (für die Verknüpfung beim Anlegen). */
export async function listLinkableUsers(ctx: Ctx) {
  authorize(ctx, "hr.employee.write");
  const linked = await db.employee.findMany({ where: { organizationId: ctx.organizationId, userId: { not: null } }, select: { userId: true } });
  const members = await db.organizationMembership.findMany({
    where: { organizationId: ctx.organizationId, user: { active: true }, userId: { notIn: linked.map((l) => l.userId!) } },
    select: { user: { select: { id: true, name: true, email: true } } },
  });
  return members.map((m) => m.user);
}
