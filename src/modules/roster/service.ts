import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, can, ForbiddenError, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { approvedAbsences, employeeBasics, employeeByUser, employmentOn } from "@/modules/hr/queries";
import { addDays, isoFromDate, dateFromIso } from "@/modules/hr/queries";
import {
  assignInput, qualificationInput, rosterInput, rulesInput, shiftInput, siteInput, swapRequestInput, templateInput,
} from "./schema";
import {
  checkPerson, checkShiftDefinition, checkStaffing, DEFAULT_RULES, durationMinutes, type RuleParams, type Span, type Violation,
} from "./rules";
import { localDateOf, NonexistentLocalTimeError, shiftInstants } from "./timezone";

type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

async function emit(tx: Tx, ctx: Ctx, type: string, payload: Prisma.InputJsonValue) {
  await tx.outboxEvent.create({ data: { organizationId: ctx.organizationId, type, payload } });
}
const canRead = (ctx: Ctx) => can(ctx, "roster.read_all") || can(ctx, "roster.plan");
function authorizeRead(ctx: Ctx) {
  if (!canRead(ctx)) authorize(ctx, "roster.read_all");
}

// ───────────────────────── Stammdaten der Planung ─────────────────────────

export async function listSites(ctx: Ctx) {
  authorizeRead(ctx);
  return db.site.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" } });
}

export async function createSite(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.plan");
  const input = siteInput.parse(raw);
  return db.$transaction(async (tx) => {
    const created = await tx.site.create({ data: { organizationId: ctx.organizationId, name: input.name, timeZone: input.timeZone } });
    await writeAudit(tx, ctx, { action: "site.create", entityType: "Site", entityId: created.id, after: { name: created.name, timeZone: created.timeZone } });
    return created;
  });
}

export async function listQualifications(ctx: Ctx) {
  authorizeRead(ctx);
  return db.qualification.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" }, include: { employees: { select: { employeeId: true } } } });
}

export async function createQualification(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.plan");
  const input = qualificationInput.parse(raw);
  return db.$transaction(async (tx) => {
    const created = await tx.qualification.create({ data: { organizationId: ctx.organizationId, name: input.name } });
    await writeAudit(tx, ctx, { action: "qualification.create", entityType: "Qualification", entityId: created.id, after: { name: created.name } });
    return created;
  });
}

export async function setEmployeeQualification(ctx: Ctx, employeeId: string, qualificationId: string, on: boolean) {
  authorize(ctx, "roster.plan");
  return db.$transaction(async (tx) => {
    const [emp] = await employeeBasics(tx, ctx.organizationId, [employeeId]);
    if (!emp) throw new NotFoundError("Mitarbeiter");
    const q = await tx.qualification.findFirst({ where: { id: qualificationId, organizationId: ctx.organizationId } });
    if (!q) throw new NotFoundError("Qualifikation");
    if (on) await tx.employeeQualification.createMany({ data: [{ employeeId, qualificationId, organizationId: ctx.organizationId }], skipDuplicates: true });
    else await tx.employeeQualification.deleteMany({ where: { employeeId, qualificationId, organizationId: ctx.organizationId } });
    await writeAudit(tx, ctx, { action: on ? "qualification.grant" : "qualification.revoke", entityType: "Employee", entityId: employeeId, after: { qualificationId } });
  });
}

export async function listTemplates(ctx: Ctx) {
  authorizeRead(ctx);
  return db.shiftTemplate.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" }, include: { qualification: { select: { name: true } } } });
}

export async function createTemplate(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.plan");
  const input = templateInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (input.qualificationId && !(await tx.qualification.findFirst({ where: { id: input.qualificationId, organizationId: ctx.organizationId } })))
      throw new NotFoundError("Qualifikation");
    const created = await tx.shiftTemplate.create({
      data: { organizationId: ctx.organizationId, name: input.name, startTime: input.startTime, endTime: input.endTime, breakMinutes: input.breakMinutes, requiredCount: input.requiredCount, qualificationId: input.qualificationId ?? null },
    });
    await writeAudit(tx, ctx, { action: "shift_template.create", entityType: "ShiftTemplate", entityId: created.id, after: { name: created.name } });
    return created;
  });
}

// ───────────────────────── Regeln ─────────────────────────

async function loadRules(tx: Tx | typeof db, organizationId: string): Promise<RuleParams> {
  const r = await tx.rosterRules.findUnique({ where: { organizationId } });
  return r ? { restDailyMinutes: r.restDailyMinutes, maxDailyMinutes: r.maxDailyMinutes, maxWeeklyMinutes: r.maxWeeklyMinutes, breakAfterMinutes: r.breakAfterMinutes, minBreakMinutes: r.minBreakMinutes, weeklyRestMinutes: r.weeklyRestMinutes } : DEFAULT_RULES;
}

export async function getRules(ctx: Ctx) {
  authorizeRead(ctx);
  return loadRules(db, ctx.organizationId);
}

export async function setRules(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.rules.manage");
  const input = rulesInput.parse(raw);
  return db.$transaction(async (tx) => {
    const before = await loadRules(tx, ctx.organizationId);
    await tx.rosterRules.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...input }, update: input });
    await writeAudit(tx, ctx, { action: "roster_rules.set", entityType: "RosterRules", entityId: ctx.organizationId, before: before as unknown as Prisma.InputJsonValue, after: input });
  });
}

async function orgTimeZone(tx: Tx | typeof db, organizationId: string) {
  return (await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timeZone: true } })).timeZone;
}

// ───────────────────────── Prüfungen ─────────────────────────

const span = (s: { id: string; startAt: Date; endAt: Date; breakMinutes: number }): Span => ({ shiftId: s.id, start: s.startAt, end: s.endAt, breakMinutes: s.breakMinutes });

/** Alle zugewiesenen Schichten einer Person im Zeitfenster (über alle Pläne der Organisation). */
async function loadSpans(tx: Tx, organizationId: string, employeeId: string, from: Date, to: Date): Promise<Span[]> {
  const rows = await tx.shiftAssignment.findMany({
    where: { organizationId, employeeId, shift: { startAt: { gte: from, lte: to } } },
    select: { shift: { select: { id: true, startAt: true, endAt: true, breakMinutes: true } } },
  });
  return rows.map((r) => span(r.shift));
}

const WINDOW = 14 * DAY;

type ShiftWithMeta = { id: string; localDate: Date; startAt: Date; endAt: Date; qualificationId: string | null };

/** Prüft, ob eine Person der Schicht zugewiesen werden darf (Abwesenheit, Beschäftigung, Qualifikation, Arbeitszeitregeln). */
async function assignmentViolations(tx: Tx, organizationId: string, shift: ShiftWithMeta, employeeId: string, rules: RuleParams, tz: string, opts: { ignoreShiftIds?: string[] } = {}): Promise<Violation[]> {
  const v: Violation[] = [];
  const err = (code: Violation["code"], message: string) => v.push({ code, severity: "ERROR", message, shiftIds: [shift.id], employeeId });

  const [emp] = await employeeBasics(tx, organizationId, [employeeId]);
  if (!emp || !emp.active) { err("NOT_EMPLOYED", "Der Mitarbeiter ist nicht aktiv"); return v; }

  const startDay = localDateOf(shift.startAt, tz), endDay = localDateOf(shift.endAt, tz);
  const abs = await approvedAbsences(tx, organizationId, [employeeId], startDay, endDay);
  for (const a of abs) err("ABSENCE", `Genehmigte Abwesenheit (${a.type}) ${a.from} bis ${a.to}`);

  if ((await employmentOn(tx, organizationId, employeeId, startDay)) === "not_covered") err("NOT_EMPLOYED", "Kein gültiges Beschäftigungsverhältnis an diesem Tag");

  if (shift.qualificationId) {
    const has = await tx.employeeQualification.findFirst({ where: { employeeId, qualificationId: shift.qualificationId, organizationId } });
    if (!has) err("QUALIFICATION", "Die nötige Qualifikation fehlt");
  }

  const spans = (await loadSpans(tx, organizationId, employeeId, new Date(shift.startAt.getTime() - WINDOW), new Date(shift.endAt.getTime() + WINDOW)))
    .filter((s) => s.shiftId !== shift.id && !(opts.ignoreShiftIds ?? []).includes(s.shiftId));
  const own = await tx.shift.findUniqueOrThrow({ where: { id: shift.id }, select: { breakMinutes: true } });
  const all = [...spans, { shiftId: shift.id, start: shift.startAt, end: shift.endAt, breakMinutes: own.breakMinutes }];
  for (const x of checkPerson(all, rules, tz, employeeId)) if (x.shiftIds.includes(shift.id)) v.push(x);
  return v;
}

export interface RosterCheck {
  violations: Violation[];
  errors: number;
  warnings: number;
}

/** Vollständige Prüfung eines Plans (Arbeitskopie). */
async function checkRoster(tx: Tx, organizationId: string, rosterId: string): Promise<RosterCheck> {
  const roster = await tx.roster.findFirstOrThrow({
    where: { id: rosterId, organizationId }, include: { site: true, shifts: { include: { assignments: true } } },
  });
  const rules = await loadRules(tx, organizationId);
  const tz = await orgTimeZone(tx, organizationId);
  const violations: Violation[] = [];
  const rosterShiftIds = new Set(roster.shifts.map((s) => s.id));

  for (const s of roster.shifts) {
    const sp = span(s);
    violations.push(...checkShiftDefinition(sp, rules));
    violations.push(...checkStaffing(s.id, s.requiredCount, s.assignments.length));
    for (const a of s.assignments) {
      const meta: ShiftWithMeta = s;
      // Abwesenheit, Beschäftigung, Qualifikation je Zuweisung (Arbeitszeitregeln folgen je Person unten)
      const per = await assignmentViolations(tx, organizationId, meta, a.employeeId, { ...rules, restDailyMinutes: 0, maxDailyMinutes: 99_999, maxWeeklyMinutes: 99_999, weeklyRestMinutes: 0 }, tz);
      violations.push(...per.filter((x) => ["ABSENCE", "NOT_EMPLOYED", "QUALIFICATION"].includes(x.code)));
    }
  }
  const employeeIds = [...new Set(roster.shifts.flatMap((s) => s.assignments.map((a) => a.employeeId)))];
  const from = new Date(isoFromDate(roster.startDate) + "T00:00:00Z"), to = new Date(addDays(isoFromDate(roster.endDate), 1) + "T00:00:00Z");
  for (const employeeId of employeeIds) {
    const spans = await loadSpans(tx, organizationId, employeeId, new Date(from.getTime() - WINDOW), new Date(to.getTime() + WINDOW));
    for (const x of checkPerson(spans, rules, tz, employeeId)) if (x.shiftIds.some((id) => rosterShiftIds.has(id))) violations.push(x);
  }
  return { violations, errors: violations.filter((x) => x.severity === "ERROR").length, warnings: violations.filter((x) => x.severity === "WARNING").length };
}

// ───────────────────────── Pläne ─────────────────────────

export async function listRosters(ctx: Ctx) {
  authorizeRead(ctx);
  return db.roster.findMany({
    where: { organizationId: ctx.organizationId }, orderBy: { startDate: "desc" }, take: 100,
    include: { site: { select: { name: true } }, _count: { select: { shifts: true } } },
  });
}

export async function createRoster(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.plan");
  const input = rosterInput.parse(raw);
  const days = Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / DAY) + 1;
  if (days > 42) throw new ConflictError("Ein Plan darf höchstens 42 Tage umfassen");
  return db.$transaction(async (tx) => {
    const site = await tx.site.findFirst({ where: { id: input.siteId, organizationId: ctx.organizationId, active: true } });
    if (!site) throw new NotFoundError("Standort");
    const overlapping = await tx.roster.findFirst({
      where: { organizationId: ctx.organizationId, siteId: site.id, startDate: { lte: dateFromIso(input.endDate) }, endDate: { gte: dateFromIso(input.startDate) } },
    });
    if (overlapping) throw new ConflictError("Für diesen Standort gibt es im Zeitraum bereits einen Plan");
    const created = await tx.roster.create({ data: { organizationId: ctx.organizationId, siteId: site.id, startDate: dateFromIso(input.startDate), endDate: dateFromIso(input.endDate) } });
    await writeAudit(tx, ctx, { action: "roster.create", entityType: "Roster", entityId: created.id, after: { siteId: site.id, from: input.startDate, to: input.endDate } });
    return created;
  });
}

export async function getRoster(ctx: Ctx, id: string) {
  authorizeRead(ctx);
  return db.$transaction(async (tx) => {
    const roster = await tx.roster.findFirst({
      where: { id, organizationId: ctx.organizationId },
      include: {
        site: true,
        shifts: { orderBy: { startAt: "asc" }, include: { assignments: true, qualification: { select: { name: true } } } },
        versions: { orderBy: { version: "desc" }, select: { version: true, publishedAt: true, publishedById: true, changes: true } },
      },
    });
    if (!roster) throw new NotFoundError("Dienstplan");
    const people = await employeeBasics(tx, ctx.organizationId, [...new Set(roster.shifts.flatMap((s) => s.assignments.map((a) => a.employeeId)))]);
    const check = await checkRoster(tx, ctx.organizationId, id);
    return { roster, people: new Map(people.map((p) => [p.id, p])), check };
  });
}

async function markDirty(tx: Tx, rosterId: string) {
  await tx.roster.update({ where: { id: rosterId }, data: { dirty: true } });
}

export async function addShift(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.plan");
  const input = shiftInput.parse(raw);
  return db.$transaction(async (tx) => {
    const roster = await tx.roster.findFirst({ where: { id: input.rosterId, organizationId: ctx.organizationId }, include: { site: true } });
    if (!roster) throw new NotFoundError("Dienstplan");
    if (input.date < isoFromDate(roster.startDate) || input.date > isoFromDate(roster.endDate)) throw new ConflictError("Das Datum liegt außerhalb des Planzeitraums");
    if (input.qualificationId && !(await tx.qualification.findFirst({ where: { id: input.qualificationId, organizationId: ctx.organizationId } }))) throw new NotFoundError("Qualifikation");
    let inst;
    try { inst = shiftInstants(input.date, input.startTime, input.endTime, roster.site.timeZone); }
    catch (e) { if (e instanceof NonexistentLocalTimeError) throw new ConflictError(e.message); throw e; }
    const rules = await loadRules(tx, ctx.organizationId);
    const errors = checkShiftDefinition({ shiftId: "new", start: inst.startAt, end: inst.endAt, breakMinutes: input.breakMinutes }, rules).filter((x) => x.severity === "ERROR");
    if (errors.length > 0) throw new ConflictError(errors.map((e) => e.message).join("; "));
    const created = await tx.shift.create({
      data: {
        organizationId: ctx.organizationId, rosterId: roster.id, localDate: dateFromIso(input.date), startAt: inst.startAt, endAt: inst.endAt,
        breakMinutes: input.breakMinutes, requiredCount: input.requiredCount, qualificationId: input.qualificationId ?? null, label: input.label ?? null,
      },
    });
    await markDirty(tx, roster.id);
    await writeAudit(tx, ctx, { action: "shift.add", entityType: "Shift", entityId: created.id, after: { rosterId: roster.id, date: input.date, from: input.startTime, to: input.endTime, required: input.requiredCount } });
    return created;
  });
}

export async function removeShift(ctx: Ctx, shiftId: string) {
  authorize(ctx, "roster.plan");
  return db.$transaction(async (tx) => {
    const shift = await tx.shift.findFirst({ where: { id: shiftId, organizationId: ctx.organizationId }, include: { assignments: true } });
    if (!shift) throw new NotFoundError("Schicht");
    await tx.shift.delete({ where: { id: shift.id } });
    await markDirty(tx, shift.rosterId);
    await writeAudit(tx, ctx, { action: "shift.remove", entityType: "Shift", entityId: shift.id, before: { rosterId: shift.rosterId, assigned: shift.assignments.length } });
  });
}

export async function assignEmployee(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.plan");
  const input = assignInput.parse(raw);
  return db.$transaction(async (tx) => {
    const shift = await tx.shift.findFirst({ where: { id: input.shiftId, organizationId: ctx.organizationId } });
    if (!shift) throw new NotFoundError("Schicht");
    // Zuweisungen je Person serialisieren (verhindert gleichzeitige Doppelbuchung)
    await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${input.employeeId} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const [emp] = await employeeBasics(tx, ctx.organizationId, [input.employeeId]);
    if (!emp) throw new NotFoundError("Mitarbeiter");
    if (await tx.shiftAssignment.findFirst({ where: { shiftId: shift.id, employeeId: emp.id } })) throw new ConflictError("Die Person ist dieser Schicht bereits zugewiesen");
    const rules = await loadRules(tx, ctx.organizationId);
    const v = await assignmentViolations(tx, ctx.organizationId, shift, emp.id, rules, await orgTimeZone(tx, ctx.organizationId));
    const errors = v.filter((x) => x.severity === "ERROR");
    if (errors.length > 0) throw new ConflictError(errors.map((e) => e.message).join("; "));
    await tx.shiftAssignment.create({ data: { organizationId: ctx.organizationId, shiftId: shift.id, employeeId: emp.id } });
    await markDirty(tx, shift.rosterId);
    await writeAudit(tx, ctx, { action: "shift.assign", entityType: "Shift", entityId: shift.id, after: { employeeId: emp.id } });
    return { warnings: v.filter((x) => x.severity === "WARNING").map((x) => x.message) };
  });
}

export async function unassignEmployee(ctx: Ctx, shiftId: string, employeeId: string) {
  authorize(ctx, "roster.plan");
  return db.$transaction(async (tx) => {
    const shift = await tx.shift.findFirst({ where: { id: shiftId, organizationId: ctx.organizationId } });
    if (!shift) throw new NotFoundError("Schicht");
    const r = await tx.shiftAssignment.deleteMany({ where: { shiftId, employeeId, organizationId: ctx.organizationId } });
    if (r.count === 0) throw new NotFoundError("Zuweisung");
    await markDirty(tx, shift.rosterId);
    await writeAudit(tx, ctx, { action: "shift.unassign", entityType: "Shift", entityId: shiftId, before: { employeeId } });
  });
}

// ───────────────────────── Veröffentlichen (Versionen) ─────────────────────────

interface SnapshotShift { shiftId: string; start: string; end: string; breakMinutes: number; required: number; label: string | null; qualification: string | null; employees: { id: string; name: string }[] }

/** Schreibt eine neue unveränderliche Version aus der Arbeitskopie und ersetzt die Projektion der veröffentlichten Schichten. */
async function createVersion(tx: Tx, ctx: Ctx, rosterId: string, reason: string, extraChanges: Record<string, unknown> = {}) {
  const roster = await tx.roster.findFirstOrThrow({
    where: { id: rosterId, organizationId: ctx.organizationId },
    include: { site: true, shifts: { orderBy: { startAt: "asc" }, include: { assignments: true, qualification: { select: { name: true } } } } },
  });
  const people = await employeeBasics(tx, ctx.organizationId, [...new Set(roster.shifts.flatMap((s) => s.assignments.map((a) => a.employeeId)))]);
  const names = new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));
  const snapshot: SnapshotShift[] = roster.shifts.map((s) => ({
    shiftId: s.id, start: s.startAt.toISOString(), end: s.endAt.toISOString(), breakMinutes: s.breakMinutes, required: s.requiredCount,
    label: s.label, qualification: s.qualification?.name ?? null,
    employees: s.assignments.map((a) => ({ id: a.employeeId, name: names.get(a.employeeId) ?? "?" })),
  }));

  const prev = await tx.rosterVersion.findFirst({ where: { rosterId }, orderBy: { version: "desc" } });
  const prevPairs = new Map<string, { shiftId: string; employeeId: string; start: string }>();
  for (const s of (prev?.snapshot as unknown as SnapshotShift[] | undefined) ?? []) for (const e of s.employees) prevPairs.set(`${s.shiftId}:${e.id}`, { shiftId: s.shiftId, employeeId: e.id, start: s.start });
  const nowPairs = new Map<string, { shiftId: string; employeeId: string; start: string }>();
  for (const s of snapshot) for (const e of s.employees) nowPairs.set(`${s.shiftId}:${e.id}`, { shiftId: s.shiftId, employeeId: e.id, start: s.start });
  const added = [...nowPairs].filter(([k]) => !prevPairs.has(k)).map(([, v]) => v);
  const removed = [...prevPairs].filter(([k]) => !nowPairs.has(k)).map(([, v]) => v);

  const version = roster.publishedVersion + 1;
  await tx.rosterVersion.create({
    data: {
      organizationId: ctx.organizationId, rosterId, version, snapshot: snapshot as unknown as Prisma.InputJsonValue,
      changes: { reason, added, removed, ...extraChanges } as unknown as Prisma.InputJsonValue, publishedById: ctx.userId,
    },
  });
  await tx.publishedShift.deleteMany({ where: { rosterId, organizationId: ctx.organizationId } });
  const rows = roster.shifts.flatMap((s) => s.assignments.map((a) => ({
    organizationId: ctx.organizationId, rosterId, version, shiftId: s.id, employeeId: a.employeeId, startAt: s.startAt, endAt: s.endAt,
    breakMinutes: s.breakMinutes, siteName: roster.site.name, label: s.label,
  })));
  if (rows.length > 0) await tx.publishedShift.createMany({ data: rows });
  await tx.roster.update({ where: { id: rosterId }, data: { publishedVersion: version, dirty: false } });
  return { version, added, removed };
}

export async function publishRoster(ctx: Ctx, rosterId: string, reason = "") {
  authorize(ctx, "roster.publish");
  return db.$transaction(async (tx) => {
    const roster = await tx.roster.findFirst({ where: { id: rosterId, organizationId: ctx.organizationId } });
    if (!roster) throw new NotFoundError("Dienstplan");
    if (!roster.dirty && roster.publishedVersion > 0) throw new ConflictError("Es gibt keine Änderungen seit der letzten Veröffentlichung");
    // Zuweisungen sperren: während der Prüfung darf sich nichts ändern
    await tx.$queryRaw`SELECT "id" FROM "Roster" WHERE "id" = ${rosterId} FOR UPDATE`;
    const check = await checkRoster(tx, ctx.organizationId, rosterId);
    const errors = check.violations.filter((v) => v.severity === "ERROR");
    if (errors.length > 0) throw new ConflictError(`Veröffentlichung nicht möglich (${errors.length} Regelverstöße): ${[...new Set(errors.map((e) => e.message))].slice(0, 3).join("; ")}`);
    const result = await createVersion(tx, ctx, rosterId, reason || (roster.publishedVersion === 0 ? "Erstveröffentlichung" : "Änderung"));
    await writeAudit(tx, ctx, { action: "roster.publish", entityType: "Roster", entityId: rosterId, after: { version: result.version, added: result.added.length, removed: result.removed.length, warnings: check.warnings } });
    await emit(tx, ctx, "roster.published", { rosterId, version: result.version });
    return result;
  });
}

// ───────────────────────── Mein Dienstplan und Tausch ─────────────────────────

async function selfOrThrow(tx: Tx | typeof db, ctx: Ctx) {
  const me = await employeeByUser(tx as Tx, ctx.organizationId, ctx.userId);
  if (!me || !me.active) throw new ConflictError("Ihrem Benutzerkonto ist kein aktives Mitarbeiterprofil zugeordnet");
  return me;
}

export async function listMyShifts(ctx: Ctx, from = new Date()) {
  const me = await employeeByUser(db as unknown as Tx, ctx.organizationId, ctx.userId);
  if (!me) return [];
  return db.publishedShift.findMany({
    where: { organizationId: ctx.organizationId, employeeId: me.id, endAt: { gte: from } }, orderBy: { startAt: "asc" }, take: 200,
  });
}

export async function requestSwap(ctx: Ctx, raw: unknown) {
  authorize(ctx, "roster.swap.request");
  const input = swapRequestInput.parse(raw);
  return db.$transaction(async (tx) => {
    const me = await selfOrThrow(tx, ctx);
    const mine = await tx.publishedShift.findFirst({ where: { organizationId: ctx.organizationId, shiftId: input.shiftId, employeeId: me.id } });
    if (!mine) throw new NotFoundError("Veröffentlichte Schicht");
    if (mine.startAt <= new Date()) throw new ConflictError("Begonnene oder vergangene Schichten können nicht getauscht werden");
    if (input.toEmployeeId === me.id) throw new ConflictError("Der Tausch mit sich selbst ist nicht möglich");
    const [peer] = await employeeBasics(tx, ctx.organizationId, [input.toEmployeeId]);
    if (!peer || !peer.active) throw new NotFoundError("Mitarbeiter");
    if (await tx.shiftAssignment.findFirst({ where: { shiftId: input.shiftId, employeeId: peer.id } })) throw new ConflictError("Die Person ist dieser Schicht bereits zugewiesen");
    if (await tx.shiftSwapRequest.findFirst({ where: { shiftId: input.shiftId, fromEmployeeId: me.id, status: { in: ["PENDING_PEER", "PENDING_APPROVAL"] } } })) throw new ConflictError("Für diese Schicht läuft bereits eine Tauschanfrage");
    const created = await tx.shiftSwapRequest.create({
      data: { organizationId: ctx.organizationId, rosterId: mine.rosterId, shiftId: input.shiftId, fromEmployeeId: me.id, toEmployeeId: peer.id, note: input.note ?? null },
    });
    await writeAudit(tx, ctx, { action: "swap.request", entityType: "ShiftSwapRequest", entityId: created.id, after: { shiftId: input.shiftId, to: peer.id } });
    await emit(tx, ctx, "swap.requested", { swapId: created.id });
    return created;
  });
}

/** Kollegin/Kollege antwortet. Bei Zusage wird sofort geprüft, ob die Schicht für sie/ihn zulässig ist. */
export async function respondSwap(ctx: Ctx, swapId: string, accept: boolean) {
  return db.$transaction(async (tx) => {
    const me = await selfOrThrow(tx, ctx);
    const swap = await tx.shiftSwapRequest.findFirst({ where: { id: swapId, organizationId: ctx.organizationId }, include: { shift: true } });
    if (!swap) throw new NotFoundError("Tauschanfrage");
    if (swap.toEmployeeId !== me.id) throw new ForbiddenError("roster.swap.request");
    if (swap.status !== "PENDING_PEER") throw new ConflictError("Die Anfrage ist nicht mehr offen");
    if (accept) {
      const rules = await loadRules(tx, ctx.organizationId);
      const v = await assignmentViolations(tx, ctx.organizationId, swap.shift, me.id, rules, await orgTimeZone(tx, ctx.organizationId));
      const errors = v.filter((x) => x.severity === "ERROR");
      if (errors.length > 0) throw new ConflictError(`Sie können die Schicht nicht übernehmen: ${errors.map((e) => e.message).join("; ")}`);
    }
    const claimed = await tx.shiftSwapRequest.updateMany({ where: { id: swap.id, status: "PENDING_PEER" }, data: { status: accept ? "PENDING_APPROVAL" : "REJECTED" } });
    if (claimed.count !== 1) throw new ConflictError("Die Anfrage wurde bereits beantwortet");
    await writeAudit(tx, ctx, { action: accept ? "swap.accept" : "swap.decline", entityType: "ShiftSwapRequest", entityId: swap.id });
    await emit(tx, ctx, accept ? "swap.accepted" : "swap.declined", { swapId: swap.id });
  });
}

export async function cancelSwap(ctx: Ctx, swapId: string) {
  return db.$transaction(async (tx) => {
    const me = await selfOrThrow(tx, ctx);
    const swap = await tx.shiftSwapRequest.findFirst({ where: { id: swapId, organizationId: ctx.organizationId } });
    if (!swap) throw new NotFoundError("Tauschanfrage");
    if (swap.fromEmployeeId !== me.id) throw new ForbiddenError("roster.swap.request");
    const r = await tx.shiftSwapRequest.updateMany({ where: { id: swap.id, status: { in: ["PENDING_PEER", "PENDING_APPROVAL"] } }, data: { status: "CANCELLED" } });
    if (r.count !== 1) throw new ConflictError("Die Anfrage ist nicht mehr offen");
    await writeAudit(tx, ctx, { action: "swap.cancel", entityType: "ShiftSwapRequest", entityId: swap.id });
  });
}

/** Freigabe durch Planung oder die direkte Führungskraft; wendet den Tausch an und veröffentlicht automatisch eine neue Version. */
export async function decideSwap(ctx: Ctx, swapId: string, approve: boolean) {
  authorize(ctx, "roster.swap.approve");
  return db.$transaction(async (tx) => {
    const swap = await tx.shiftSwapRequest.findFirst({ where: { id: swapId, organizationId: ctx.organizationId }, include: { shift: true, roster: true } });
    if (!swap) throw new NotFoundError("Tauschanfrage");
    const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
    if (me && (me.id === swap.fromEmployeeId || me.id === swap.toEmployeeId)) throw new ConflictError("Beteiligte dürfen den eigenen Tausch nicht freigeben");
    if (!can(ctx, "roster.plan")) {
      const [from] = await employeeBasics(tx, ctx.organizationId, [swap.fromEmployeeId]);
      if (!me || !from || from.managerId !== me.id) throw new ForbiddenError("roster.swap.approve");
    }
    if (swap.status !== "PENDING_APPROVAL") throw new ConflictError("Die Anfrage wartet nicht auf Freigabe");
    const claimed = await tx.shiftSwapRequest.updateMany({ where: { id: swap.id, status: "PENDING_APPROVAL" }, data: { status: approve ? "APPROVED" : "REJECTED", decidedById: ctx.userId } });
    if (claimed.count !== 1) throw new ConflictError("Die Anfrage wurde bereits entschieden");

    if (approve) {
      await tx.$queryRaw`SELECT "id" FROM "Roster" WHERE "id" = ${swap.rosterId} FOR UPDATE`;
      const roster = await tx.roster.findFirstOrThrow({ where: { id: swap.rosterId } });
      if (roster.dirty) throw new ConflictError("Der Plan hat unveröffentlichte Änderungen. Bitte zuerst veröffentlichen, dann den Tausch freigeben");
      const stillMine = await tx.shiftAssignment.findFirst({ where: { shiftId: swap.shiftId, employeeId: swap.fromEmployeeId } });
      if (!stillMine) throw new ConflictError("Die Schicht ist der Person nicht mehr zugewiesen");
      const rules = await loadRules(tx, ctx.organizationId);
      const v = await assignmentViolations(tx, ctx.organizationId, swap.shift, swap.toEmployeeId, rules, await orgTimeZone(tx, ctx.organizationId));
      const errors = v.filter((x) => x.severity === "ERROR");
      if (errors.length > 0) throw new ConflictError(`Tausch nicht zulässig: ${errors.map((e) => e.message).join("; ")}`);
      await tx.shiftAssignment.updateMany({ where: { shiftId: swap.shiftId, employeeId: swap.fromEmployeeId }, data: { employeeId: swap.toEmployeeId } });
      await createVersion(tx, ctx, swap.rosterId, "Schichttausch", { swap: { swapId: swap.id, from: swap.fromEmployeeId, to: swap.toEmployeeId, shiftId: swap.shiftId } });
    }
    await writeAudit(tx, ctx, { action: approve ? "swap.approve" : "swap.reject", entityType: "ShiftSwapRequest", entityId: swap.id });
    await emit(tx, ctx, approve ? "swap.approved" : "swap.rejected", { swapId: swap.id });
  });
}

export async function listSwaps(ctx: Ctx) {
  const me = await employeeByUser(db as unknown as Tx, ctx.organizationId, ctx.userId);
  const include = { shift: { select: { startAt: true, endAt: true, label: true } }, roster: { select: { site: { select: { name: true } } } } } as const;
  const mineWhere = me ? { OR: [{ fromEmployeeId: me.id }, { toEmployeeId: me.id }] } : { id: "none" };
  const [mine, toApprove] = await Promise.all([
    db.shiftSwapRequest.findMany({ where: { organizationId: ctx.organizationId, status: { in: ["PENDING_PEER", "PENDING_APPROVAL"] }, ...mineWhere }, orderBy: { createdAt: "desc" }, include }),
    can(ctx, "roster.swap.approve")
      ? db.shiftSwapRequest.findMany({
          where: {
            organizationId: ctx.organizationId, status: "PENDING_APPROVAL",
            ...(can(ctx, "roster.plan") ? {} : { /* nur Team: direkte Führungskraft des Antragstellers */ }),
          },
          orderBy: { createdAt: "asc" }, include,
        })
      : Promise.resolve([]),
  ]);
  let approvable = toApprove;
  if (!can(ctx, "roster.plan")) {
    const ids = [...new Set(toApprove.map((s) => s.fromEmployeeId))];
    const basics = await employeeBasics(db as unknown as Tx, ctx.organizationId, ids);
    const reports = new Set(basics.filter((b) => me && b.managerId === me.id).map((b) => b.id));
    approvable = toApprove.filter((s) => reports.has(s.fromEmployeeId));
  }
  approvable = approvable.filter((s) => !me || (s.fromEmployeeId !== me.id && s.toEmployeeId !== me.id));
  const ids = [...new Set([...mine, ...approvable].flatMap((s) => [s.fromEmployeeId, s.toEmployeeId]))];
  const people = new Map((await employeeBasics(db as unknown as Tx, ctx.organizationId, ids)).map((p) => [p.id, `${p.firstName} ${p.lastName}`]));
  return { me, mine, approvable, people };
}

/** Mitarbeiter der Organisation, mit denen getauscht werden kann (Name, ID). */
export async function listSwapCandidates(ctx: Ctx) {
  authorize(ctx, "roster.swap.request");
  const me = await employeeByUser(db as unknown as Tx, ctx.organizationId, ctx.userId);
  const rows = await db.employee.findMany({ where: { organizationId: ctx.organizationId, active: true, id: { not: me?.id ?? "none" } }, select: { id: true, firstName: true, lastName: true }, orderBy: { lastName: "asc" } });
  return rows;
}

export { durationMinutes };
