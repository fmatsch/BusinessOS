import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, can, ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { approvedAbsences, employeeBasics, employeeByUser, employmentsOverlapping } from "@/modules/hr/queries";
import { checkPerson, checkShiftDefinition, loadRules, plannedMinutesByDay, workMinutes, type Span, type Violation } from "@/modules/roster/queries";
import { addDaysIso, localDateOf, zonedToUtc } from "./deps";
import { absenceDaySet, categoryMinutes, monthBounds, monthTarget, scaleToNet } from "./rules";
import {
  adjustmentInput, clockInInput, decisionInput, directAddInput, directCorrectInput, directDeleteInput, entryRequestInput, payCodeInput,
  periodKey, reopenInput, returnInput, submitInput,
} from "./schema";

type Tx = Prisma.TransactionClient;
const MIN = 60_000;
const MAX_CLOCK_MINUTES = 16 * 60;
const TOLERANCE_MINUTES = 15;

async function emit(tx: Tx, ctx: Ctx, type: string, payload: Prisma.InputJsonValue) {
  await tx.outboxEvent.create({ data: { organizationId: ctx.organizationId, type, payload } });
}
const orgTz = async (tx: Tx | typeof db, organizationId: string) => (await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timeZone: true } })).timeZone;
const minutes = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MIN);
const monthOf = (date: string) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) });

async function selfEmployee(tx: Tx, ctx: Ctx) {
  authorize(ctx, "time.entry.own");
  const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
  if (!me || !me.active) throw new ConflictError("Ihrem Benutzerkonto ist kein aktives Mitarbeiterprofil zugeordnet");
  return me;
}

type Basic = NonNullable<Awaited<ReturnType<typeof employeeByUser>>>;

/** Zugriff auf Zeitdaten einer Person: sie selbst, Personalwesen/Inhaber (read_all) oder die direkte Führungskraft. */
async function accessEmployee(tx: Tx, ctx: Ctx, employeeId: string): Promise<{ employee: Basic; self: boolean }> {
  const [employee] = await employeeBasics(tx, ctx.organizationId, [employeeId]);
  if (!employee) throw new NotFoundError("Mitarbeiter");
  if (employee.userId === ctx.userId) return { employee, self: true };
  if (can(ctx, "time.entry.read_all")) return { employee, self: false };
  if (can(ctx, "time.period.approve")) {
    const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
    if (me && employee.managerId === me.id) return { employee, self: false };
  }
  throw new ForbiddenError("time.entry.read_all");
}

/** Darf der Benutzer Anträge/Abschlüsse dieser Person entscheiden? (nie die eigenen; Führungskraft nur ihr Team) */
async function assertCanApprove(tx: Tx, ctx: Ctx, employee: Basic) {
  if (employee.userId === ctx.userId) throw new ConflictError("Eigene Zeiten dürfen nicht selbst freigegeben werden");
  if (can(ctx, "time.period.approve_all")) return;
  authorize(ctx, "time.period.approve");
  const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
  if (!me || employee.managerId !== me.id) throw new ForbiddenError("time.period.approve");
}

async function lockEmployee(tx: Tx, organizationId: string, employeeId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} AND "organizationId" = ${organizationId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Mitarbeiter");
}

// ───────────────────────── Journal-Grundoperationen ─────────────────────────

export interface Interval { startAt: Date; endAt: Date; breakMinutes: number; costCenterId?: string | null }

function validateInterval(iv: Interval, now: Date) {
  const dur = minutes(iv.startAt, iv.endAt);
  if (dur <= 0) throw new ConflictError("Das Ende muss nach dem Beginn liegen");
  if (dur > 24 * 60) throw new ConflictError("Eine Buchung darf höchstens 24 Stunden umfassen");
  if (iv.breakMinutes < 0 || iv.breakMinutes >= dur) throw new ConflictError("Die Pause muss kürzer als die Buchung sein");
  if (iv.endAt.getTime() > now.getTime() + MIN) throw new ConflictError("Zeiten in der Zukunft können nicht gebucht werden");
}

function localInterval(date: string, startTime: string, endTime: string, tz: string, breakMinutes: number, costCenterId?: string | null): Interval {
  const startAt = zonedToUtc(date, startTime, tz);
  const endAt = zonedToUtc(endTime <= startTime ? addDaysIso(date, 1) : date, endTime, tz);
  return { startAt, endAt, breakMinutes, costCenterId };
}

/** Wirksame (nicht stornierte) Arbeitsbuchungen. */
const effective = (organizationId: string, employeeId: string): Prisma.TimeEntryWhereInput => ({ organizationId, employeeId, kind: "WORK", reversedBy: null });

async function assertNoOverlap(tx: Tx, organizationId: string, employeeId: string, iv: Interval, excludeId?: string) {
  const clash = await tx.timeEntry.findFirst({
    where: { ...effective(organizationId, employeeId), startAt: { lt: iv.endAt }, endAt: { gt: iv.startAt }, ...(excludeId ? { id: { not: excludeId } } : {}) },
  });
  if (clash) throw new ConflictError("Die Zeit überschneidet sich mit einer bestehenden Buchung");
}

/** Gesperrte Perioden verhindern Buchungen: freigegeben = für alle gesperrt, eingereicht = für die Person selbst gesperrt. */
async function assertUnlocked(tx: Tx, organizationId: string, employeeId: string, iv: { startAt: Date; endAt: Date }, tz: string, opts: { selfAction: boolean }) {
  const months = new Map<string, { year: number; month: number }>();
  for (const d of [localDateOf(iv.startAt, tz), localDateOf(new Date(iv.endAt.getTime() - 1), tz)]) months.set(d.slice(0, 7), monthOf(d));
  for (const { year, month } of months.values()) {
    const p = await tx.timesheetPeriod.findUnique({ where: { organizationId_employeeId_year_month: { organizationId, employeeId, year, month } } });
    if (p?.status === "APPROVED") throw new ConflictError(`Der Monat ${String(month).padStart(2, "0")}/${year} ist abgeschlossen und gesperrt`);
    if (p?.status === "SUBMITTED" && opts.selfAction) throw new ConflictError(`Der Monat ${String(month).padStart(2, "0")}/${year} ist zur Freigabe eingereicht`);
  }
}

async function insertWork(tx: Tx, ctx: Ctx, employeeId: string, iv: Interval, source: "CLOCK" | "MANUAL" | "CORRECTION", tz: string, reason?: string, replacesId?: string) {
  if (iv.costCenterId && !(await tx.costCenter.findFirst({ where: { id: iv.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
  const localDate = new Date(`${localDateOf(iv.startAt, tz)}T00:00:00Z`);
  return tx.timeEntry.create({
    data: {
      organizationId: ctx.organizationId, employeeId, kind: "WORK", startAt: iv.startAt, endAt: iv.endAt, breakMinutes: iv.breakMinutes, localDate,
      costCenterId: iv.costCenterId ?? null, source, reason: reason ?? null, replacesId: replacesId ?? null, createdById: ctx.userId,
    },
  });
}

async function reverseEntry(tx: Tx, ctx: Ctx, entry: { id: string; employeeId: string; startAt: Date; endAt: Date; breakMinutes: number; localDate: Date; costCenterId: string | null }, reason: string) {
  return tx.timeEntry.create({
    data: {
      organizationId: ctx.organizationId, employeeId: entry.employeeId, kind: "REVERSAL", startAt: entry.startAt, endAt: entry.endAt, breakMinutes: entry.breakMinutes,
      localDate: entry.localDate, costCenterId: entry.costCenterId, source: "REVERSAL", reason, reversesId: entry.id, createdById: ctx.userId,
    },
  });
}

async function findEffective(tx: Tx, organizationId: string, employeeId: string | null, id: string) {
  const e = await tx.timeEntry.findFirst({ where: { id, organizationId, kind: "WORK", reversedBy: null, ...(employeeId ? { employeeId } : {}) } });
  if (!e) throw new NotFoundError("Zeitbuchung");
  return e;
}

// ───────────────────────── Stempeluhr ─────────────────────────

export async function getClock(ctx: Ctx) {
  authorize(ctx, "time.entry.own");
  const me = await employeeByUser(db as unknown as Tx, ctx.organizationId, ctx.userId);
  if (!me) return null;
  return db.timeClock.findUnique({ where: { employeeId: me.id } });
}

export async function clockIn(ctx: Ctx, raw: unknown = {}, now = new Date()) {
  const input = clockInInput.parse(raw);
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    await lockEmployee(tx, ctx.organizationId, me.id);
    if (await tx.timeClock.findUnique({ where: { employeeId: me.id } })) throw new ConflictError("Sie sind bereits eingestempelt");
    if (input.costCenterId && !(await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId, active: true } }))) throw new NotFoundError("Kostenstelle");
    const tz = await orgTz(tx, ctx.organizationId);
    await assertUnlocked(tx, ctx.organizationId, me.id, { startAt: now, endAt: new Date(now.getTime() + MIN) }, tz, { selfAction: true });
    await assertNoOverlap(tx, ctx.organizationId, me.id, { startAt: now, endAt: new Date(now.getTime() + MIN), breakMinutes: 0 });
    const clock = await tx.timeClock.create({ data: { employeeId: me.id, organizationId: ctx.organizationId, startedAt: now, costCenterId: input.costCenterId ?? null } });
    await writeAudit(tx, ctx, { action: "time.clock_in", entityType: "Employee", entityId: me.id });
    return clock;
  });
}

export async function startBreak(ctx: Ctx, now = new Date()) {
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    const clock = await tx.timeClock.findUnique({ where: { employeeId: me.id } });
    if (!clock) throw new ConflictError("Sie sind nicht eingestempelt");
    if (clock.breakStartedAt) throw new ConflictError("Die Pause läuft bereits");
    await tx.timeClock.update({ where: { employeeId: me.id }, data: { breakStartedAt: now } });
  });
}

export async function endBreak(ctx: Ctx, now = new Date()) {
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    const clock = await tx.timeClock.findUnique({ where: { employeeId: me.id } });
    if (!clock?.breakStartedAt) throw new ConflictError("Es läuft keine Pause");
    await tx.timeClock.update({ where: { employeeId: me.id }, data: { breakStartedAt: null, breakMinutes: clock.breakMinutes + Math.max(0, minutes(clock.breakStartedAt, now)) } });
  });
}

export async function clockOut(ctx: Ctx, now = new Date()) {
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    await lockEmployee(tx, ctx.organizationId, me.id);
    const clock = await tx.timeClock.findUnique({ where: { employeeId: me.id } });
    if (!clock) throw new ConflictError("Sie sind nicht eingestempelt");
    const breakMinutes = clock.breakMinutes + (clock.breakStartedAt ? Math.max(0, minutes(clock.breakStartedAt, now)) : 0);
    const iv: Interval = { startAt: clock.startedAt, endAt: now, breakMinutes, costCenterId: clock.costCenterId };
    if (minutes(iv.startAt, iv.endAt) > MAX_CLOCK_MINUTES)
      throw new ConflictError("Die Stempelung läuft seit mehr als 16 Stunden (Ausstempeln vergessen?). Bitte verwerfen und die Zeit als Antrag erfassen");
    if (minutes(iv.startAt, iv.endAt) < 1) throw new ConflictError("Die Stempelung ist kürzer als eine Minute – bitte verwerfen");
    const tz = await orgTz(tx, ctx.organizationId);
    await assertUnlocked(tx, ctx.organizationId, me.id, iv, tz, { selfAction: true });
    await assertNoOverlap(tx, ctx.organizationId, me.id, iv);
    const entry = await insertWork(tx, ctx, me.id, iv, "CLOCK", tz);
    await tx.timeClock.delete({ where: { employeeId: me.id } });
    await writeAudit(tx, ctx, { action: "time.clock_out", entityType: "TimeEntry", entityId: entry.id, after: { minutes: minutes(iv.startAt, iv.endAt), breakMinutes } });
    return entry;
  });
}

/** Läuft eine Stempelung falsch (z. B. vergessen), wird sie verworfen und die Zeit als Antrag erfasst. */
export async function discardClock(ctx: Ctx) {
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    const r = await tx.timeClock.deleteMany({ where: { employeeId: me.id } });
    if (r.count === 0) throw new ConflictError("Sie sind nicht eingestempelt");
    await writeAudit(tx, ctx, { action: "time.clock_discard", entityType: "Employee", entityId: me.id });
  });
}

// ───────────────────────── Anträge (nachträgliche Erfassung, Korrektur) ─────────────────────────

export async function requestEntry(ctx: Ctx, raw: unknown, now = new Date()) {
  const input = entryRequestInput.parse(raw);
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    await lockEmployee(tx, ctx.organizationId, me.id);
    const tz = await orgTz(tx, ctx.organizationId);
    let iv: Interval | null = null;
    let target: Awaited<ReturnType<typeof findEffective>> | null = null;
    if (input.type !== "ADD") target = await findEffective(tx, ctx.organizationId, me.id, input.targetEntryId);
    if (input.type !== "DELETE") {
      iv = localInterval(input.date, input.startTime, input.endTime, tz, input.breakMinutes, input.costCenterId);
      validateInterval(iv, now);
      if (iv.costCenterId && !(await tx.costCenter.findFirst({ where: { id: iv.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
      await assertNoOverlap(tx, ctx.organizationId, me.id, iv, target?.id);
      await assertUnlocked(tx, ctx.organizationId, me.id, iv, tz, { selfAction: true });
    }
    if (target) await assertUnlocked(tx, ctx.organizationId, me.id, target, tz, { selfAction: true });
    if (target && (await tx.timeEntryRequest.findFirst({ where: { organizationId: ctx.organizationId, targetEntryId: target.id, status: "PENDING" } }))) throw new ConflictError("Für diese Buchung gibt es bereits einen offenen Antrag");
    const created = await tx.timeEntryRequest.create({
      data: {
        organizationId: ctx.organizationId, employeeId: me.id, type: input.type, targetEntryId: target?.id ?? null, startAt: iv?.startAt ?? null, endAt: iv?.endAt ?? null,
        breakMinutes: iv?.breakMinutes ?? null, costCenterId: iv?.costCenterId ?? null, reason: input.reason,
      },
    });
    await writeAudit(tx, ctx, { action: "time.request", entityType: "TimeEntryRequest", entityId: created.id, after: { type: input.type, targetEntryId: target?.id ?? null } });
    await emit(tx, ctx, "time.request.created", { requestId: created.id });
    return created;
  });
}

export async function cancelRequest(ctx: Ctx, requestId: string) {
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    const r = await tx.timeEntryRequest.updateMany({ where: { id: requestId, organizationId: ctx.organizationId, employeeId: me.id, status: "PENDING" }, data: { status: "CANCELLED" } });
    if (r.count !== 1) throw new NotFoundError("Offener Antrag");
    await writeAudit(tx, ctx, { action: "time.request_cancel", entityType: "TimeEntryRequest", entityId: requestId });
  });
}

export async function decideEntryRequest(ctx: Ctx, raw: unknown, now = new Date()) {
  const input = decisionInput.parse(raw);
  return db.$transaction(async (tx) => {
    const req = await tx.timeEntryRequest.findFirst({ where: { id: input.requestId, organizationId: ctx.organizationId } });
    if (!req) throw new NotFoundError("Zeitantrag");
    const [employee] = await employeeBasics(tx, ctx.organizationId, [req.employeeId]);
    if (!employee) throw new NotFoundError("Mitarbeiter");
    await assertCanApprove(tx, ctx, employee);
    await lockEmployee(tx, ctx.organizationId, req.employeeId);
    if (req.status !== "PENDING") throw new ConflictError("Der Antrag ist nicht mehr offen");

    if (input.decision === "APPROVE") {
      const tz = await orgTz(tx, ctx.organizationId);
      let target: Awaited<ReturnType<typeof findEffective>> | null = null;
      if (req.type !== "ADD") target = await findEffective(tx, ctx.organizationId, req.employeeId, req.targetEntryId!).catch(() => { throw new ConflictError("Die betroffene Buchung wurde inzwischen geändert"); });
      const iv: Interval | null = req.type === "DELETE" ? null : { startAt: req.startAt!, endAt: req.endAt!, breakMinutes: req.breakMinutes ?? 0, costCenterId: req.costCenterId };
      // Perioden prüfen: jede Änderung an freigegebenen oder eingereichten Monaten ist nicht möglich (Personalwesen kann den Monat öffnen/zurückgeben)
      if (iv) await assertUnlocked(tx, ctx.organizationId, req.employeeId, iv, tz, { selfAction: true });
      if (target) await assertUnlocked(tx, ctx.organizationId, req.employeeId, target, tz, { selfAction: true });
      if (iv) { validateInterval(iv, now); await assertNoOverlap(tx, ctx.organizationId, req.employeeId, iv, target?.id); }
      const ctxReason = `Antrag ${req.id}: ${req.reason}`;
      if (req.type === "ADD") await insertWork(tx, ctx, req.employeeId, iv!, "MANUAL", tz, ctxReason);
      else if (req.type === "CORRECT") { await reverseEntry(tx, ctx, target!, ctxReason); await insertWork(tx, ctx, req.employeeId, iv!, "CORRECTION", tz, ctxReason, target!.id); }
      else await reverseEntry(tx, ctx, target!, ctxReason);
    }
    const claimed = await tx.timeEntryRequest.updateMany({
      where: { id: req.id, status: "PENDING" }, data: { status: input.decision === "APPROVE" ? "APPROVED" : "REJECTED", decidedById: ctx.userId, decidedAt: new Date(), comment: input.comment ?? null },
    });
    if (claimed.count !== 1) throw new ConflictError("Der Antrag wurde bereits entschieden");
    await writeAudit(tx, ctx, { action: `time.request_${input.decision === "APPROVE" ? "approve" : "reject"}`, entityType: "TimeEntryRequest", entityId: req.id, after: { type: req.type, comment: input.comment ?? null } });
    await emit(tx, ctx, "time.request.decided", { requestId: req.id });
  });
}

// ───────────────────────── Direkte Korrekturen durch das Personalwesen ─────────────────────────

export async function addEntryDirect(ctx: Ctx, raw: unknown, now = new Date()) {
  authorize(ctx, "time.entry.correct");
  const input = directAddInput.parse(raw);
  return db.$transaction(async (tx) => {
    const { employee } = await accessEmployee(tx, ctx, input.employeeId);
    await lockEmployee(tx, ctx.organizationId, employee.id);
    const tz = await orgTz(tx, ctx.organizationId);
    const iv = localInterval(input.date, input.startTime, input.endTime, tz, input.breakMinutes, input.costCenterId);
    validateInterval(iv, now);
    await assertUnlocked(tx, ctx.organizationId, employee.id, iv, tz, { selfAction: false });
    await assertNoOverlap(tx, ctx.organizationId, employee.id, iv);
    const e = await insertWork(tx, ctx, employee.id, iv, "MANUAL", tz, input.reason);
    await writeAudit(tx, ctx, { action: "time.add_direct", entityType: "TimeEntry", entityId: e.id, after: { employeeId: employee.id, reason: input.reason } });
    return e;
  });
}

export async function correctEntryDirect(ctx: Ctx, raw: unknown, now = new Date()) {
  authorize(ctx, "time.entry.correct");
  const input = directCorrectInput.parse(raw);
  return db.$transaction(async (tx) => {
    const target = await findEffective(tx, ctx.organizationId, null, input.entryId);
    await accessEmployee(tx, ctx, target.employeeId);
    await lockEmployee(tx, ctx.organizationId, target.employeeId);
    const tz = await orgTz(tx, ctx.organizationId);
    const iv = localInterval(input.date, input.startTime, input.endTime, tz, input.breakMinutes, input.costCenterId);
    validateInterval(iv, now);
    await assertUnlocked(tx, ctx.organizationId, target.employeeId, iv, tz, { selfAction: false });
    await assertUnlocked(tx, ctx.organizationId, target.employeeId, target, tz, { selfAction: false });
    await assertNoOverlap(tx, ctx.organizationId, target.employeeId, iv, target.id);
    await reverseEntry(tx, ctx, target, input.reason);
    const e = await insertWork(tx, ctx, target.employeeId, iv, "CORRECTION", tz, input.reason, target.id);
    await writeAudit(tx, ctx, { action: "time.correct_direct", entityType: "TimeEntry", entityId: e.id, before: { replaced: target.id }, after: { reason: input.reason } });
    return e;
  });
}

export async function deleteEntryDirect(ctx: Ctx, raw: unknown) {
  authorize(ctx, "time.entry.correct");
  const input = directDeleteInput.parse(raw);
  return db.$transaction(async (tx) => {
    const target = await findEffective(tx, ctx.organizationId, null, input.entryId);
    await accessEmployee(tx, ctx, target.employeeId);
    await lockEmployee(tx, ctx.organizationId, target.employeeId);
    await assertUnlocked(tx, ctx.organizationId, target.employeeId, target, await orgTz(tx, ctx.organizationId), { selfAction: false });
    await reverseEntry(tx, ctx, target, input.reason);
    await writeAudit(tx, ctx, { action: "time.delete_direct", entityType: "TimeEntry", entityId: target.id, after: { reason: input.reason } });
  });
}

// ───────────────────────── Monatsauswertung ─────────────────────────

export interface DayRow { date: string; planned: number; actual: number; delta: number; absence: boolean; flag: "MISSING" | "DEVIATION" | null }
export interface PeriodSummary {
  year: number; month: number;
  workedMinutes: number; targetMinutes: number; deltaMinutes: number; coveredDays: number;
  categories: { night: number; sunday: number; holiday: number; overtime: number };
  days: DayRow[];
  hints: { code: string; severity: "ERROR" | "WARNING"; message: string }[];
}

/** Rechnet Ist, Soll, Zuschlagskategorien, Plan/Ist und Compliance-Hinweise für einen Monat. Reine Lesefunktion. */
async function computeSummary(tx: Tx, organizationId: string, employeeId: string, year: number, month: number): Promise<PeriodSummary> {
  const tz = await orgTz(tx, organizationId);
  const b = monthBounds(year, month, tz);
  const rules = await loadRules(tx, organizationId);
  const entries = await tx.timeEntry.findMany({ where: { ...effective(organizationId, employeeId), startAt: { gte: new Date(b.from.getTime() - 14 * 86_400_000), lt: new Date(b.to.getTime() + 14 * 86_400_000) } }, orderBy: { startAt: "asc" } });
  const inMonth = entries.filter((e) => e.startAt >= b.from && e.startAt < b.to);

  let worked = 0, night = 0, sunday = 0, holiday = 0;
  const actualByDay = new Map<string, number>();
  const hints: PeriodSummary["hints"] = [];
  for (const e of inMonth) {
    const net = minutes(e.startAt, e.endAt) - e.breakMinutes;
    worked += net;
    const c = scaleToNet(categoryMinutes(e.startAt, e.endAt, tz), net);
    night += c.night; sunday += c.sunday; holiday += c.holiday;
    const day = localDateOf(e.startAt, tz);
    actualByDay.set(day, (actualByDay.get(day) ?? 0) + net);
    for (const v of checkShiftDefinition({ shiftId: e.id, start: e.startAt, end: e.endAt, breakMinutes: e.breakMinutes }, rules)) hints.push({ code: v.code, severity: v.severity, message: `${day}: ${v.message}` });
  }
  const spans: Span[] = entries.map((e) => ({ shiftId: e.id, start: e.startAt, end: e.endAt, breakMinutes: e.breakMinutes }));
  const inMonthIds = new Set(inMonth.map((e) => e.id));
  const person: Violation[] = checkPerson(spans, rules, tz, employeeId).filter((v) => v.shiftIds.some((id) => inMonthIds.has(id)));
  for (const v of person) hints.push({ code: v.code, severity: v.severity, message: v.message });

  const absences = await approvedAbsences(tx, organizationId, [employeeId], b.firstDay, b.lastDay);
  const absenceDays = absenceDaySet(absences.map((a) => ({ from: a.from, to: a.to })), year, month);
  const employments = await employmentsOverlapping(tx, organizationId, employeeId, b.firstDay, b.lastDay);
  const target = monthTarget(year, month, employments, absenceDays);
  const planned = await plannedMinutesByDay(tx, organizationId, employeeId, b.from, b.to, tz);

  const days: DayRow[] = [];
  const allDays = new Set([...planned.keys(), ...actualByDay.keys()]);
  for (const date of [...allDays].sort()) {
    const p = planned.get(date) ?? 0, a = actualByDay.get(date) ?? 0, abs = absenceDays.has(date);
    const delta = a - p;
    const flag: DayRow["flag"] = p > 0 && a === 0 && !abs ? "MISSING" : Math.abs(delta) > TOLERANCE_MINUTES && p > 0 && !abs ? "DEVIATION" : null;
    days.push({ date, planned: p, actual: a, delta, absence: abs, flag });
  }
  if (target.coveredDays === 0) hints.push({ code: "NO_EMPLOYMENT", severity: "WARNING", message: "Für diesen Monat sind keine Beschäftigungsdaten hinterlegt – es gibt kein Sollzeit" });
  const delta = worked - target.targetMinutes;
  return { year, month, workedMinutes: worked, targetMinutes: target.targetMinutes, deltaMinutes: delta, coveredDays: target.coveredDays, categories: { night, sunday, holiday, overtime: Math.max(0, delta) }, days, hints };
}

// ───────────────────────── Ansicht einer Person ─────────────────────────

export async function getEmployeeTime(ctx: Ctx, employeeId: string, year: number, month: number) {
  return db.$transaction(async (tx) => {
    const { employee, self } = await accessEmployee(tx, ctx, employeeId);
    const tz = await orgTz(tx, ctx.organizationId);
    const b = monthBounds(year, month, tz);
    const summary = await computeSummary(tx, ctx.organizationId, employee.id, year, month);
    const entries = await tx.timeEntry.findMany({
      where: { organizationId: ctx.organizationId, employeeId: employee.id, startAt: { gte: b.from, lt: b.to } }, orderBy: [{ startAt: "desc" }, { createdAt: "desc" }],
      include: { reversedBy: { select: { id: true } } },
    });
    const period = await tx.timesheetPeriod.findUnique({ where: { organizationId_employeeId_year_month: { organizationId: ctx.organizationId, employeeId: employee.id, year, month } } });
    const requests = await tx.timeEntryRequest.findMany({ where: { organizationId: ctx.organizationId, employeeId: employee.id }, orderBy: { createdAt: "desc" }, take: 30 });
    const balance = (await tx.timeAccountEntry.aggregate({ where: { organizationId: ctx.organizationId, employeeId: employee.id }, _sum: { minutes: true } }))._sum.minutes ?? 0;
    const clock = await tx.timeClock.findUnique({ where: { employeeId: employee.id } });
    // Zugriffe auf Zeitdaten anderer Personen werden protokolliert (Auskunfts- und Nachweispflicht)
    if (!self) await writeAudit(tx, ctx, { action: "time.read_other", entityType: "Employee", entityId: employee.id, after: { year, month } });
    return { employee, self, tz, summary, entries, period, requests, balance, clock };
  });
}

export async function getMyEmployeeId(ctx: Ctx) {
  const me = await employeeByUser(db as unknown as Tx, ctx.organizationId, ctx.userId);
  return me?.id ?? null;
}

// ───────────────────────── Monatsabschluss ─────────────────────────

export async function submitPeriod(ctx: Ctx, raw: unknown, now = new Date()) {
  const input = submitInput.parse(raw);
  return db.$transaction(async (tx) => {
    const me = await selfEmployee(tx, ctx);
    await lockEmployee(tx, ctx.organizationId, me.id);
    const tz = await orgTz(tx, ctx.organizationId);
    const b = monthBounds(input.year, input.month, tz);
    if (b.from > now) throw new ConflictError("Ein Monat in der Zukunft kann nicht eingereicht werden");
    if (await tx.timeClock.findUnique({ where: { employeeId: me.id } })) throw new ConflictError("Bitte zuerst ausstempeln");
    if (await tx.timeEntryRequest.findFirst({ where: { organizationId: ctx.organizationId, employeeId: me.id, status: "PENDING" } })) throw new ConflictError("Es gibt noch offene Korrekturanträge");
    const key = { organizationId: ctx.organizationId, employeeId: me.id, year: input.year, month: input.month };
    const existing = await tx.timesheetPeriod.findUnique({ where: { organizationId_employeeId_year_month: key } });
    if (existing && existing.status !== "OPEN") throw new ConflictError(existing.status === "APPROVED" ? "Der Monat ist bereits freigegeben" : "Der Monat ist bereits eingereicht");
    await tx.timesheetPeriod.upsert({ where: { organizationId_employeeId_year_month: key }, create: { ...key, status: "SUBMITTED", submittedAt: now }, update: { status: "SUBMITTED", submittedAt: now } });
    await writeAudit(tx, ctx, { action: "time.period_submit", entityType: "Employee", entityId: me.id, after: { year: input.year, month: input.month } });
    await emit(tx, ctx, "time.period.submitted", { employeeId: me.id, year: input.year, month: input.month });
  });
}

/** Freigabe sperrt den Monat und bucht das Ergebnis (Ist − Soll) ins Zeitkonto. */
export async function approvePeriod(ctx: Ctx, raw: unknown) {
  const input = periodKey.parse(raw);
  return db.$transaction(async (tx) => {
    const [employee] = await employeeBasics(tx, ctx.organizationId, [input.employeeId]);
    if (!employee) throw new NotFoundError("Mitarbeiter");
    await assertCanApprove(tx, ctx, employee);
    await lockEmployee(tx, ctx.organizationId, employee.id);
    const key = { organizationId: ctx.organizationId, employeeId: employee.id, year: input.year, month: input.month };
    const period = await tx.timesheetPeriod.findUnique({ where: { organizationId_employeeId_year_month: key } });
    if (!period || period.status !== "SUBMITTED") throw new ConflictError("Der Monat wurde nicht eingereicht");
    if (await tx.timeEntryRequest.findFirst({ where: { organizationId: ctx.organizationId, employeeId: employee.id, status: "PENDING" } })) throw new ConflictError("Es gibt noch offene Korrekturanträge");
    const summary = await computeSummary(tx, ctx.organizationId, employee.id, input.year, input.month);
    if (summary.coveredDays === 0) throw new ConflictError("Für diesen Monat sind keine Beschäftigungsdaten hinterlegt – bitte zuerst erfassen");
    const claimed = await tx.timesheetPeriod.updateMany({ where: { id: period.id, status: "SUBMITTED" }, data: { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date(), summary: summary as unknown as Prisma.InputJsonValue } });
    if (claimed.count !== 1) throw new ConflictError("Der Monat wurde bereits entschieden");
    if (summary.deltaMinutes !== 0)
      await tx.timeAccountEntry.create({ data: { organizationId: ctx.organizationId, employeeId: employee.id, kind: "PERIOD", minutes: summary.deltaMinutes, periodId: period.id, year: input.year, month: input.month, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "time.period_approve", entityType: "TimesheetPeriod", entityId: period.id, after: { worked: summary.workedMinutes, target: summary.targetMinutes, delta: summary.deltaMinutes } });
    await emit(tx, ctx, "time.period.approved", { employeeId: employee.id, year: input.year, month: input.month });
    return summary;
  });
}

/** Zurück an die Person (z. B. wegen Fehlern), solange der Monat nicht freigegeben ist. */
export async function returnPeriod(ctx: Ctx, raw: unknown) {
  const input = returnInput.parse(raw);
  return db.$transaction(async (tx) => {
    const [employee] = await employeeBasics(tx, ctx.organizationId, [input.employeeId]);
    if (!employee) throw new NotFoundError("Mitarbeiter");
    await assertCanApprove(tx, ctx, employee);
    const r = await tx.timesheetPeriod.updateMany({ where: { organizationId: ctx.organizationId, employeeId: employee.id, year: input.year, month: input.month, status: "SUBMITTED" }, data: { status: "OPEN", submittedAt: null } });
    if (r.count !== 1) throw new ConflictError("Der Monat wurde nicht eingereicht");
    await writeAudit(tx, ctx, { action: "time.period_return", entityType: "Employee", entityId: employee.id, after: { year: input.year, month: input.month, comment: input.comment } });
    await emit(tx, ctx, "time.period.returned", { employeeId: employee.id, year: input.year, month: input.month, comment: input.comment });
  });
}

/** Freigegebenen Monat wieder öffnen (nur Personalwesen/Inhaber, mit Begründung): Zeitkonto wird per Gegenbuchung korrigiert. */
export async function reopenPeriod(ctx: Ctx, raw: unknown) {
  authorize(ctx, "time.period.reopen");
  const input = reopenInput.parse(raw);
  return db.$transaction(async (tx) => {
    const [employee] = await employeeBasics(tx, ctx.organizationId, [input.employeeId]);
    if (!employee) throw new NotFoundError("Mitarbeiter");
    await lockEmployee(tx, ctx.organizationId, employee.id);
    const key = { organizationId: ctx.organizationId, employeeId: employee.id, year: input.year, month: input.month };
    const period = await tx.timesheetPeriod.findUnique({ where: { organizationId_employeeId_year_month: key } });
    if (!period || period.status !== "APPROVED") throw new ConflictError("Der Monat ist nicht freigegeben");
    const posted = await tx.timeAccountEntry.findFirst({ where: { organizationId: ctx.organizationId, periodId: period.id, kind: "PERIOD" }, orderBy: { createdAt: "desc" } });
    const reversed = posted ? await tx.timeAccountEntry.findFirst({ where: { organizationId: ctx.organizationId, periodId: period.id, kind: "REVERSAL", createdAt: { gt: posted.createdAt } } }) : null;
    if (posted && !reversed)
      await tx.timeAccountEntry.create({ data: { organizationId: ctx.organizationId, employeeId: employee.id, kind: "REVERSAL", minutes: -posted.minutes, periodId: period.id, year: input.year, month: input.month, note: input.reason, createdById: ctx.userId } });
    await tx.timesheetPeriod.update({ where: { id: period.id }, data: { status: "OPEN", approvedById: null, approvedAt: null, submittedAt: null, summary: Prisma.DbNull, reopenCount: { increment: 1 } } });
    await writeAudit(tx, ctx, { action: "time.period_reopen", entityType: "TimesheetPeriod", entityId: period.id, before: { status: "APPROVED" }, after: { reason: input.reason } });
    await emit(tx, ctx, "time.period.reopened", { employeeId: employee.id, year: input.year, month: input.month });
  });
}

// ───────────────────────── Zeitkonto ─────────────────────────

export async function addAccountAdjustment(ctx: Ctx, raw: unknown) {
  authorize(ctx, "time.account.write");
  const input = adjustmentInput.parse(raw);
  return db.$transaction(async (tx) => {
    const [employee] = await employeeBasics(tx, ctx.organizationId, [input.employeeId]);
    if (!employee) throw new NotFoundError("Mitarbeiter");
    await lockEmployee(tx, ctx.organizationId, employee.id);
    const created = await tx.timeAccountEntry.create({ data: { organizationId: ctx.organizationId, employeeId: employee.id, kind: "ADJUSTMENT", minutes: input.minutes, note: input.note, createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "time.account_adjust", entityType: "TimeAccountEntry", entityId: created.id, after: { employeeId: employee.id, minutes: input.minutes } });
    return created;
  });
}

export async function listAccountEntries(ctx: Ctx, employeeId: string) {
  return db.$transaction(async (tx) => {
    await accessEmployee(tx, ctx, employeeId);
    return tx.timeAccountEntry.findMany({ where: { organizationId: ctx.organizationId, employeeId }, orderBy: { createdAt: "desc" }, take: 100 });
  });
}

// ───────────────────────── Team und offene Entscheidungen ─────────────────────────

export async function listTeam(ctx: Ctx, year: number, month: number) {
  const readAll = can(ctx, "time.entry.read_all");
  if (!readAll) authorize(ctx, "time.period.approve");
  const me = await employeeByUser(db as unknown as Tx, ctx.organizationId, ctx.userId);
  const employees = await db.employee.findMany({
    where: { organizationId: ctx.organizationId, active: true, ...(readAll ? {} : { managerId: me?.id ?? "none" }) },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }], select: { id: true, firstName: true, lastName: true, userId: true },
  });
  const ids = employees.map((e) => e.id);
  const [periods, requests] = await Promise.all([
    db.timesheetPeriod.findMany({ where: { organizationId: ctx.organizationId, employeeId: { in: ids }, year, month } }),
    db.timeEntryRequest.findMany({ where: { organizationId: ctx.organizationId, employeeId: { in: ids }, status: "PENDING" }, orderBy: { createdAt: "asc" } }),
  ]);
  const pByEmp = new Map(periods.map((p) => [p.employeeId, p]));
  return {
    rows: employees.map((e) => ({ ...e, status: pByEmp.get(e.id)?.status ?? "OPEN", pendingRequests: requests.filter((r) => r.employeeId === e.id).length })),
    pendingRequests: requests.filter((r) => employees.find((e) => e.id === r.employeeId)?.userId !== ctx.userId),
    names: new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`])),
  };
}

// ───────────────────────── Zuschlagsregeln (Konfiguration) ─────────────────────────

export const DEFAULT_PAY_CODES = { NIGHT: 25, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 } as const;

export async function getPayCodeRules(ctx: Ctx) {
  if (!can(ctx, "time.rules.manage")) authorize(ctx, "time.entry.read_all");
  const rows = await db.payCodeRule.findMany({ where: { organizationId: ctx.organizationId } });
  const out: Record<string, number> = { ...DEFAULT_PAY_CODES };
  for (const r of rows) out[r.kind] = Number(r.percent.toString());
  return out as Record<keyof typeof DEFAULT_PAY_CODES, number>;
}

export async function setPayCodeRules(ctx: Ctx, raw: unknown) {
  authorize(ctx, "time.rules.manage");
  const input = payCodeInput.parse(raw);
  return db.$transaction(async (tx) => {
    for (const [kind, percent] of Object.entries(input)) await tx.payCodeRule.upsert({ where: { organizationId_kind: { organizationId: ctx.organizationId, kind } }, create: { organizationId: ctx.organizationId, kind, percent }, update: { percent } });
    await writeAudit(tx, ctx, { action: "pay_code_rules.set", entityType: "PayCodeRule", entityId: ctx.organizationId, after: input });
  });
}

export { workMinutes };
