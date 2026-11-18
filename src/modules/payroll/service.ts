import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { authorize, can, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { absenceDaysByType, employeesEmployedIn } from "@/modules/hr/queries";
import { payCodePercents, periodsOf } from "@/modules/time/queries";
import { buildCsv, encodeCsv, fileNameFor, sha256, type CsvProfile } from "./csv";
import { ABSENCE_WAGE_TYPES, desiredQuantities, diffQuantities, percentFor, WAGE_TYPES, type WageType } from "./lines";
import { exportInput, monthInput, profileInput } from "./schema";

type Tx = Prisma.TransactionClient;

export const DEFAULT_PROFILE: CsvProfile = {
  delimiter: ";", decimalSeparator: ",", includeHeader: true, encoding: "utf8-bom", unit: "HOURS", includeSurcharge: true, codes: {},
};

async function loadProfile(tx: Tx | typeof db, organizationId: string): Promise<CsvProfile> {
  const p = await tx.payrollProfile.findUnique({ where: { organizationId } });
  if (!p) return DEFAULT_PROFILE;
  return {
    delimiter: p.delimiter, decimalSeparator: p.decimalSeparator, includeHeader: p.includeHeader, encoding: p.encoding as CsvProfile["encoding"],
    unit: p.unit as CsvProfile["unit"], includeSurcharge: p.includeSurcharge, codes: p.codes as CsvProfile["codes"],
  };
}

export async function getProfile(ctx: Ctx) {
  authorize(ctx, "payroll.export.read");
  return loadProfile(db, ctx.organizationId);
}

export async function setProfile(ctx: Ctx, raw: unknown) {
  authorize(ctx, "payroll.profile.manage");
  const input = profileInput.parse(raw);
  return db.$transaction(async (tx) => {
    const before = await loadProfile(tx, ctx.organizationId);
    await tx.payrollProfile.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...input }, update: input });
    await writeAudit(tx, ctx, { action: "payroll_profile.set", entityType: "PayrollProfile", entityId: ctx.organizationId, before: before as unknown as Prisma.InputJsonValue, after: input as unknown as Prisma.InputJsonValue });
  });
}

// ───────────────────────── Vorschau und Plausibilitätsprüfung ─────────────────────────

export interface PreviewLine { wageType: WageType; quantity: number; percent: number | null }
export interface PreviewEmployee { employeeId: string; number: string; name: string; lines: PreviewLine[] }
export interface Check { severity: "ERROR" | "WARNING" | "INFO"; message: string }
export interface Preview {
  year: number; month: number;
  /** laufende Nummer des nächsten Laufs (1 = Erstexport, ab 2 = Nachtrag) */
  nextVersion: number;
  employees: PreviewEmployee[];
  /** Beschäftigte ohne freigegebenen Monat – im Lauf nicht enthalten */
  incomplete: { employeeId: string; number: string; name: string; reason: string }[];
  checks: Check[];
  exported: { version: number; createdAt: Date; lineCount: number }[];
}

async function buildPreview(tx: Tx, organizationId: string, year: number, month: number): Promise<Preview> {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const profile = await loadProfile(tx, organizationId);
  const percents = await payCodePercents(tx, organizationId);
  const [expected, periods, previous, runs] = await Promise.all([
    employeesEmployedIn(tx, organizationId, first, last),
    periodsOf(tx, organizationId, year, month),
    tx.payrollExportLine.groupBy({ by: ["employeeId", "wageType"], where: { organizationId, export: { year, month } }, _sum: { quantity: true } }),
    tx.payrollExport.findMany({ where: { organizationId, year, month }, orderBy: { version: "asc" }, select: { version: true, createdAt: true, lineCount: true } }),
  ]);
  const periodOf = new Map(periods.map((p) => [p.employeeId, p]));
  const cumulative = new Map<string, Partial<Record<WageType, number>>>();
  for (const g of previous) cumulative.set(g.employeeId, { ...(cumulative.get(g.employeeId) ?? {}), [g.wageType as WageType]: g._sum.quantity ?? 0 });

  const employees: PreviewEmployee[] = [];
  const incomplete: Preview["incomplete"] = [];
  const checks: Check[] = [];
  const name = (e: { firstName: string; lastName: string }) => `${e.lastName} ${e.firstName}`;
  let flagged = 0;

  for (const e of expected) {
    const p = periodOf.get(e.id);
    if (!p || p.status !== "APPROVED" || !p.summary) {
      const wasExported = cumulative.has(e.id);
      incomplete.push({
        employeeId: e.id, number: e.number, name: name(e),
        reason: !p ? "Monat nicht eingereicht" : p.status === "SUBMITTED" ? "Monat eingereicht, noch nicht freigegeben" : wasExported ? "Monat nach dem Export wieder geöffnet" : "Monat nicht abgeschlossen",
      });
      continue;
    }
    const abs = await absenceDaysByType(tx, organizationId, e.id, year, month);
    const absenceDays = Object.fromEntries(ABSENCE_WAGE_TYPES.map((k) => [k, abs[k] ?? 0])) as Record<(typeof ABSENCE_WAGE_TYPES)[number], number>;
    const s = p.summary;
    const desired = desiredQuantities({ workedMinutes: s.workedMinutes, targetMinutes: s.targetMinutes, night: s.categories.night, sunday: s.categories.sunday, holiday: s.categories.holiday }, absenceDays);
    const lines = diffQuantities(desired, cumulative.get(e.id) ?? {}).map((d) => ({ wageType: d.wageType, quantity: d.quantity, percent: percentFor(d.wageType, percents) }));
    if (s.workedMinutes === 0 && s.targetMinutes > 0 && ABSENCE_WAGE_TYPES.every((k) => absenceDays[k] === 0))
      checks.push({ severity: "WARNING", message: `${name(e)}: keine Arbeitszeit und keine Abwesenheit, obwohl Soll vorhanden` });
    flagged += s.days.filter((d) => d.flag === "MISSING").length;
    if (lines.length > 0) employees.push({ employeeId: e.id, number: e.number, name: name(e), lines });
  }
  if (flagged > 0) checks.push({ severity: "WARNING", message: `${flagged} geplante Arbeitstage ohne Zeitbuchung in den freigegebenen Monaten (Plan/Ist-Abweichung)` });
  const used = new Set(employees.flatMap((e) => e.lines.map((l) => l.wageType)));
  const missing = WAGE_TYPES.filter((w) => used.has(w) && !profile.codes[w]);
  if (missing.length > 0) checks.push({ severity: "ERROR", message: `Lohnart-Zuordnung fehlt für: ${missing.join(", ")} (Profil unter „Format und Lohnarten")` });
  if (runs.length > 0) checks.push({ severity: "INFO", message: `Für diesen Monat gibt es bereits ${runs.length} Lauf/Läufe; der nächste Lauf enthält nur Differenzen (Nachtrag).` });
  if (employees.length === 0 && incomplete.length === 0) checks.push({ severity: "INFO", message: "Keine Änderungen seit dem letzten Export." });
  if (expected.length === 0) checks.push({ severity: "INFO", message: "Für diesen Monat gibt es keine Beschäftigten mit Beschäftigungsverhältnis." });
  return { year, month, nextVersion: (runs.at(-1)?.version ?? 0) + 1, employees, incomplete, checks, exported: runs };
}

export async function previewExport(ctx: Ctx, raw: unknown): Promise<Preview> {
  if (!can(ctx, "payroll.export.read")) authorize(ctx, "payroll.export.create");
  const input = monthInput.parse(raw);
  return db.$transaction((tx) => buildPreview(tx, ctx.organizationId, input.year, input.month));
}

// ───────────────────────── Export ─────────────────────────

export async function createExport(ctx: Ctx, raw: unknown, now = new Date()) {
  authorize(ctx, "payroll.export.create");
  const input = exportInput.parse(raw);
  return db.$transaction(async (tx) => {
    // Läufe je Monat serialisieren: keine doppelte Versionsnummer, keine doppelten Differenzen
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll:${ctx.organizationId}:${input.year}-${input.month}`}))`;
    const monthEnd = new Date(Date.UTC(input.year, input.month, 1));
    if (monthEnd > now) throw new ConflictError("Der Monat ist noch nicht abgeschlossen");
    const pv = await buildPreview(tx, ctx.organizationId, input.year, input.month);
    const errors = pv.checks.filter((c) => c.severity === "ERROR");
    if (errors.length > 0) throw new ConflictError(errors.map((e) => e.message).join("; "));
    if (pv.incomplete.length > 0 && !input.acceptIncomplete)
      throw new ConflictError(`${pv.incomplete.length} Beschäftigte haben keinen freigegebenen Monat (${pv.incomplete.slice(0, 3).map((i) => i.name).join(", ")}${pv.incomplete.length > 3 ? " …" : ""}). Bitte bestätigen, dass sie später als Nachtrag folgen`);
    if (pv.employees.length === 0) throw new ConflictError("Es gibt keine Änderungen, die exportiert werden müssten");

    const profile = await loadProfile(tx, ctx.organizationId);
    const rows = pv.employees.flatMap((e) => e.lines.map((l) => ({ employeeNumber: e.number, wageType: l.wageType, quantity: l.quantity, percent: l.percent })));
    const content = buildCsv(rows, profile, { year: input.year, month: input.month, version: pv.nextVersion });
    const bytes = encodeCsv(content, profile.encoding);
    const created = await tx.payrollExport.create({
      data: {
        organizationId: ctx.organizationId, year: input.year, month: input.month, version: pv.nextVersion, fileName: fileNameFor(input.year, input.month, pv.nextVersion),
        content, contentHash: sha256(bytes), profile: profile as unknown as Prisma.InputJsonValue, checks: pv.checks as unknown as Prisma.InputJsonValue,
        excluded: pv.incomplete as unknown as Prisma.InputJsonValue, lineCount: rows.length, createdById: ctx.userId,
        lines: {
          create: pv.employees.flatMap((e) => e.lines.map((l) => ({
            organizationId: ctx.organizationId, employeeId: e.employeeId, employeeNumber: e.number, wageType: l.wageType, quantity: l.quantity,
            unit: l.wageType === "VACATION" || l.wageType === "SICK" || l.wageType === "CARE" || l.wageType === "SPECIAL" ? "DAYS" : "MINUTES", percent: l.percent,
          }))),
        },
      },
    });
    await writeAudit(tx, ctx, {
      action: "payroll.export", entityType: "PayrollExport", entityId: created.id,
      after: { year: input.year, month: input.month, version: created.version, lines: rows.length, excluded: pv.incomplete.length, hash: created.contentHash },
    });
    return created;
  });
}

export async function listExports(ctx: Ctx) {
  authorize(ctx, "payroll.export.read");
  return db.payrollExport.findMany({
    where: { organizationId: ctx.organizationId }, orderBy: [{ year: "desc" }, { month: "desc" }, { version: "desc" }], take: 100,
    select: { id: true, year: true, month: true, version: true, fileName: true, lineCount: true, contentHash: true, createdAt: true, excluded: true },
  });
}

/** Liefert die Datei samt Integritätsprüfung (Hash der ausgelieferten Bytes) und protokolliert den Abruf. */
export async function getExportFile(ctx: Ctx, id: string) {
  authorize(ctx, "payroll.export.read");
  return db.$transaction(async (tx) => {
    const e = await tx.payrollExport.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!e) throw new NotFoundError("Exportlauf");
    const profile = e.profile as unknown as CsvProfile;
    const bytes = encodeCsv(e.content, profile.encoding);
    if (sha256(bytes) !== e.contentHash) throw new Error("Integritätsprüfung fehlgeschlagen: Dateiinhalt weicht vom Exportzeitpunkt ab");
    await writeAudit(tx, ctx, { action: "payroll.download", entityType: "PayrollExport", entityId: e.id, after: { fileName: e.fileName } });
    return { fileName: e.fileName, bytes, encoding: profile.encoding };
  });
}
