import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, can, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { emitEvent } from "@/platform/events/emit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso, employeeBasics, employeeByUser, isoFromDate } from "@/modules/hr/queries";
import { createCustomerInvoiceDraftTx } from "@/modules/finance/service";
import { crmCustomer } from "@/modules/finance/queries";
import { billInput, bookTimeInput, projectInput } from "./schema";
import { billingNet, bookingDateProblem, budgetUsedPercent, hoursToMinutes, MAX_MINUTES_PER_DAY, minutesToHours } from "./rules";

type Tx = Prisma.TransactionClient;
const todayIso = () => isoFromDate(new Date());

async function nextNumber(tx: Tx, organizationId: string, year: number) {
  const key = `PJ-${year}`;
  const seq = await tx.sequence.upsert({ where: { organizationId_key: { organizationId, key } }, create: { organizationId, key, value: 1 }, update: { value: { increment: 1 } } });
  return `${key}-${String(seq.value).padStart(4, "0")}`;
}
const lock = (tx: Tx, table: "Project" | "Employee", organizationId: string, id: string) =>
  table === "Project"
    ? tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`
    : tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${id} AND "organizationId" = ${organizationId} FOR UPDATE`;

// ───────────────────────── Projekte ─────────────────────────

export async function createProject(ctx: Ctx, raw: unknown) {
  authorize(ctx, "project.manage");
  const input = projectInput.parse(raw);
  return db.$transaction(async (tx) => {
    if (input.customerId && !(await crmCustomer(tx, ctx.organizationId, input.customerId))) throw new NotFoundError("Kunde");
    if (input.costCenterId && !(await tx.costCenter.findFirst({ where: { id: input.costCenterId, organizationId: ctx.organizationId }, select: { id: true } }))) throw new NotFoundError("Kostenstelle");
    const number = await nextNumber(tx, ctx.organizationId, new Date().getUTCFullYear());
    const created = await tx.project.create({
      data: {
        organizationId: ctx.organizationId, number, name: input.name, customerId: input.customerId ?? null, costCenterId: input.costCenterId ?? null,
        hourlyRate: input.hourlyRate?.toString() ?? null, budgetHours: input.budgetHours?.toString() ?? null,
        startsOn: input.startsOn ? dateFromIso(input.startsOn) : null, endsOn: input.endsOn ? dateFromIso(input.endsOn) : null, note: input.note ?? null, createdById: ctx.userId,
      },
    });
    await writeAudit(tx, ctx, { action: "project.create", entityType: "Project", entityId: created.id, after: { number, name: input.name } });
    return created;
  });
}

export async function setProjectStatus(ctx: Ctx, id: string, status: "ACTIVE" | "CLOSED") {
  authorize(ctx, "project.manage");
  return db.$transaction(async (tx) => {
    const r = await tx.project.updateMany({ where: { id, organizationId: ctx.organizationId, status: status === "CLOSED" ? "ACTIVE" : "CLOSED" }, data: { status } });
    if (r.count !== 1) throw new ConflictError(status === "CLOSED" ? "Das Projekt ist nicht aktiv" : "Das Projekt ist nicht abgeschlossen");
    await writeAudit(tx, ctx, { action: status === "CLOSED" ? "project.close" : "project.reopen", entityType: "Project", entityId: id });
  });
}

type Sums = Map<string, { booked: number; billed: number }>;
async function sums(tx: Tx | typeof db, organizationId: string, projectIds: string[]): Promise<Sums> {
  const [times, billed] = await Promise.all([
    tx.projectTime.groupBy({ by: ["projectId", "kind"], where: { organizationId, projectId: { in: projectIds } }, _sum: { minutes: true } }),
    tx.projectBilling.groupBy({ by: ["projectId"], where: { organizationId, projectId: { in: projectIds } }, _sum: { minutes: true } }),
  ]);
  const m: Sums = new Map(projectIds.map((id) => [id, { booked: 0, billed: 0 }]));
  for (const t of times) m.get(t.projectId)!.booked += (t.kind === "WORK" ? 1 : -1) * (t._sum.minutes ?? 0); // REVERSAL-Buchungen tragen positive Minuten und heben die Buchung auf
  for (const b of billed) m.get(b.projectId)!.billed = b._sum.minutes ?? 0;
  return m;
}

/** Projektliste. Der Verrechnungssatz erscheint nur für Personen, die Projekte verwalten oder abrechnen dürfen. */
export async function listProjects(ctx: Ctx) {
  authorize(ctx, "project.read");
  const projects = await db.project.findMany({ where: { organizationId: ctx.organizationId }, orderBy: [{ status: "asc" }, { number: "desc" }], take: 200 });
  const s = await sums(db, ctx.organizationId, projects.map((p) => p.id));
  const showRate = can(ctx, "project.manage") || can(ctx, "project.bill");
  return projects.map((p) => {
    const t = s.get(p.id)!;
    return { ...p, hourlyRate: showRate ? p.hourlyRate : null, bookedMinutes: t.booked, billedMinutes: t.billed, budgetUsed: budgetUsedPercent(t.booked, p.budgetHours) };
  });
}

/** Projektdetail mit Buchungen (alle nur mit `project.time.read_all`, sonst die eigenen) und Abrechnungsläufen. */
export async function getProject(ctx: Ctx, id: string) {
  authorize(ctx, "project.read");
  const p = await db.project.findFirst({ where: { id, organizationId: ctx.organizationId } });
  if (!p) throw new NotFoundError("Projekt");
  const all = can(ctx, "project.time.read_all");
  const me = all ? null : await employeeByUser(db, ctx.organizationId, ctx.userId);
  const [times, billings, s] = await Promise.all([
    db.projectTime.findMany({
      where: { organizationId: ctx.organizationId, projectId: id, ...(all ? {} : { employeeId: me?.id ?? "-" }) },
      orderBy: [{ workDate: "desc" }, { createdAt: "desc" }], take: 300, include: { billingItem: { select: { id: true } }, reversedBy: { select: { id: true } } },
    }),
    can(ctx, "project.bill") || can(ctx, "project.manage") ? db.projectBilling.findMany({ where: { organizationId: ctx.organizationId, projectId: id }, orderBy: { createdAt: "desc" }, take: 50 }) : Promise.resolve([]),
    sums(db, ctx.organizationId, [id]),
  ]);
  const names = new Map((await employeeBasics(db, ctx.organizationId, [...new Set(times.map((t) => t.employeeId))])).map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  const t = s.get(id)!;
  const showRate = can(ctx, "project.manage") || can(ctx, "project.bill");
  return {
    ...p, hourlyRate: showRate ? p.hourlyRate : null, bookedMinutes: t.booked, billedMinutes: t.billed, openMinutes: t.booked - t.billed, budgetUsed: budgetUsedPercent(t.booked, p.budgetHours),
    times: times.map((x) => ({ ...x, employeeName: names.get(x.employeeId) ?? "–", billed: !!x.billingItem, reversed: !!x.reversedBy })), billings,
  };
}

// ───────────────────────── Zeiten ─────────────────────────

/** Bucht Projektzeit für die eigene Person. Je Person und Tag höchstens 24 Stunden über alle Projekte. */
export async function bookProjectTime(ctx: Ctx, raw: unknown) {
  authorize(ctx, "project.time.book");
  const input = bookTimeInput.parse(raw);
  const minutes = hoursToMinutes(input.hours);
  if (minutes < 1) throw new ConflictError("Die Dauer ist zu kurz");
  return db.$transaction(async (tx) => {
    const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
    if (!me || !me.active) throw new ConflictError("Ihrem Benutzerkonto ist kein aktives Mitarbeiterprofil zugeordnet");
    await lock(tx, "Employee", ctx.organizationId, me.id); // serialisiert Buchungen je Person (Tagesgrenze)
    const p = await tx.project.findFirst({ where: { id: input.projectId, organizationId: ctx.organizationId } });
    if (!p) throw new NotFoundError("Projekt");
    if (p.status !== "ACTIVE") throw new ConflictError("Auf abgeschlossene Projekte kann nicht gebucht werden");
    const problem = bookingDateProblem(input.workDate, todayIso(), p.startsOn ? isoFromDate(p.startsOn) : null, p.endsOn ? isoFromDate(p.endsOn) : null);
    if (problem) throw new ConflictError(problem);
    const day = await tx.projectTime.groupBy({ by: ["kind"], where: { organizationId: ctx.organizationId, employeeId: me.id, workDate: dateFromIso(input.workDate) }, _sum: { minutes: true } });
    const used = day.reduce((a, g) => a + (g.kind === "WORK" ? 1 : -1) * (g._sum.minutes ?? 0), 0);
    if (used + minutes > MAX_MINUTES_PER_DAY) throw new ConflictError(`Am ${input.workDate} sind bereits ${minutesToHours(used)} Stunden gebucht; mehr als 24 Stunden je Tag sind nicht möglich`);
    const created = await tx.projectTime.create({ data: { organizationId: ctx.organizationId, projectId: p.id, employeeId: me.id, workDate: dateFromIso(input.workDate), minutes, note: input.note ?? null, kind: "WORK", createdById: ctx.userId } });
    await writeAudit(tx, ctx, { action: "project_time.book", entityType: "ProjectTime", entityId: created.id, after: { project: p.number, date: input.workDate, minutes } });
    return created;
  });
}

/** Korrektur per Gegenbuchung. Eigene Buchungen darf die Person selbst korrigieren, fremde nur mit `project.manage`. Abgerechnete nicht. */
export async function reverseProjectTime(ctx: Ctx, timeId: string, reason: string) {
  authorize(ctx, "project.read");
  const why = reason.trim();
  if (why.length < 3) throw new ConflictError("Bitte eine Begründung angeben");
  return db.$transaction(async (tx) => {
    const t = await tx.projectTime.findFirst({ where: { id: timeId, organizationId: ctx.organizationId }, include: { billingItem: true, reversedBy: true } });
    if (!t) throw new NotFoundError("Zeitbuchung");
    if (t.kind !== "WORK") throw new ConflictError("Gegenbuchungen können nicht korrigiert werden");
    const me = await employeeByUser(tx, ctx.organizationId, ctx.userId);
    if (!(me && me.id === t.employeeId && can(ctx, "project.time.book")) && !can(ctx, "project.manage")) authorize(ctx, "project.manage");
    await lock(tx, "Project", ctx.organizationId, t.projectId); // Abrechnung und Korrektur laufen nacheinander
    const fresh = await tx.projectTime.findFirstOrThrow({ where: { id: timeId }, include: { billingItem: true, reversedBy: true } });
    if (fresh.billingItem) throw new ConflictError("Die Zeit ist bereits abgerechnet; Korrekturen laufen über eine Gutschrift in den Finanzen");
    if (fresh.reversedBy) throw new ConflictError("Die Buchung wurde bereits korrigiert");
    const rev = await tx.projectTime.create({
      data: { organizationId: ctx.organizationId, projectId: t.projectId, employeeId: t.employeeId, workDate: t.workDate, minutes: t.minutes, note: why, kind: "REVERSAL", reversesId: t.id, createdById: ctx.userId },
    });
    await writeAudit(tx, ctx, { action: "project_time.reverse", entityType: "ProjectTime", entityId: rev.id, after: { reverses: t.id, reason: why } });
    return rev;
  });
}

// ───────────────────────── Abrechnung ─────────────────────────

/**
 * Rechnet alle noch nicht abgerechneten, nicht korrigierten Zeiten bis zum Stichtag ab: ein Rechnungsentwurf (Stunden × Stundensatz).
 * Jede Zeit wird höchstens einmal abgerechnet; Abrechnung und Korrektur sind per Projektsperre serialisiert.
 */
export async function billProject(ctx: Ctx, raw: unknown) {
  authorize(ctx, "project.bill");
  const input = billInput.parse(raw);
  if (input.upTo > todayIso()) throw new ConflictError("Der Stichtag liegt in der Zukunft");
  return db.$transaction(async (tx) => {
    await lock(tx, "Project", ctx.organizationId, input.projectId);
    const p = await tx.project.findFirst({ where: { id: input.projectId, organizationId: ctx.organizationId } });
    if (!p) throw new NotFoundError("Projekt");
    if (!p.customerId) throw new ConflictError("Dem Projekt ist kein Kunde zugeordnet");
    if (!p.hourlyRate || new Decimal(p.hourlyRate.toString()).lte(0)) throw new ConflictError("Dem Projekt ist kein Stundensatz zugeordnet");
    const open = await tx.projectTime.findMany({
      where: { organizationId: ctx.organizationId, projectId: p.id, kind: "WORK", workDate: { lte: dateFromIso(input.upTo) }, billingItem: null, reversedBy: null },
      select: { id: true, minutes: true, workDate: true },
    });
    if (open.length === 0) throw new ConflictError("Es gibt keine abrechenbaren Zeiten bis zum Stichtag");
    const minutes = open.reduce((a, t) => a + t.minutes, 0);
    const rate = p.hourlyRate.toString();
    const from = isoFromDate(open.reduce((a, t) => (t.workDate < a ? t.workDate : a), open[0]!.workDate));
    const inv = await createCustomerInvoiceDraftTx(tx, ctx, {
      customerId: p.customerId, invoiceDate: todayIso(), note: `Projekt ${p.number}: Leistungen ${from} bis ${input.upTo}`,
      lines: [{ description: `Projektleistungen ${p.number} ${p.name} (${from} bis ${input.upTo})`, quantity: minutesToHours(minutes).toString(), unitPrice: rate, taxCodeId: input.taxCodeId, revenueAccountId: input.revenueAccountId }],
    });
    const net = billingNet(minutes, rate);
    const billing = await tx.projectBilling.create({
      data: { organizationId: ctx.organizationId, projectId: p.id, invoiceId: inv.id, upTo: dateFromIso(input.upTo), minutes, hourlyRate: rate, netAmount: net.toString(), createdById: ctx.userId, items: { create: open.map((t) => ({ timeId: t.id })) } },
    });
    await writeAudit(tx, ctx, { action: "project.bill", entityType: "ProjectBilling", entityId: billing.id, after: { project: p.number, minutes, net: net.toString(), invoiceId: inv.id } });
    await emitEvent(tx, ctx, "project.billed", { projectId: p.id, project: p.number, minutes, net: net.toString(), href: `/projects/${p.id}` });
    return { invoiceId: inv.id, billingId: billing.id, minutes, net };
  });
}
