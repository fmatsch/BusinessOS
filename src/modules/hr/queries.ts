import type { Prisma } from "@prisma/client";
import { countWorkingDays, isoFromDate } from "./calendar";

type Tx = Prisma.TransactionClient;

/** Grunddaten von Mitarbeitern (für andere Module, z. B. Dienstplanung). Nur innerhalb der Organisation. */
export function employeeBasics(tx: Tx, organizationId: string, ids: string[]) {
  return tx.employee.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, firstName: true, lastName: true, active: true, managerId: true, userId: true },
  });
}

export function employeeByUser(tx: Tx, organizationId: string, userId: string) {
  return tx.employee.findFirst({
    where: { organizationId, userId },
    select: { id: true, firstName: true, lastName: true, active: true, managerId: true, userId: true },
  });
}

/** Genehmigte Abwesenheiten, die den Zeitraum (ISO-Daten, inklusive) berühren. */
export async function approvedAbsences(tx: Tx, organizationId: string, employeeIds: string[], fromIso: string, toIso: string) {
  const rows = await tx.absenceRequest.findMany({
    where: {
      organizationId, employeeId: { in: employeeIds }, status: "APPROVED",
      startDate: { lte: new Date(`${toIso}T00:00:00Z`) }, endDate: { gte: new Date(`${fromIso}T00:00:00Z`) },
    },
    select: { employeeId: true, startDate: true, endDate: true, type: { select: { name: true } } },
  });
  return rows.map((r) => ({ employeeId: r.employeeId, from: isoFromDate(r.startDate), to: isoFromDate(r.endDate), type: r.type.name }));
}

/**
 * Beschäftigungsstatus an einem Tag. Hat die Person noch gar keine Beschäftigungsdaten, gilt sie als „unbekannt" (nicht gesperrt),
 * damit Pläne vor der Pflege der Vertragsdaten möglich sind.
 */
export async function employmentOn(tx: Tx, organizationId: string, employeeId: string, dateIso: string): Promise<"covered" | "not_covered" | "unknown"> {
  const all = await tx.employment.findMany({ where: { organizationId, employeeId }, select: { validFrom: true, validTo: true } });
  if (all.length === 0) return "unknown";
  return all.some((e) => isoFromDate(e.validFrom) <= dateIso && (!e.validTo || isoFromDate(e.validTo) >= dateIso)) ? "covered" : "not_covered";
}

// Kalenderhilfen für andere Module (z. B. Dienstplanung)
export { addDays, dateFromIso, isoFromDate, isValidIsoDate } from "./calendar";

export { austrianHolidays, countWorkingDays, isWorkingDay } from "./calendar";

/** Beschäftigungszeiträume, die den Zeitraum berühren (ISO-Daten). */
export async function employmentsOverlapping(tx: Tx, organizationId: string, employeeId: string, fromIso: string, toIso: string) {
  const rows = await tx.employment.findMany({ where: { organizationId, employeeId } });
  return rows
    .map((e) => ({ from: isoFromDate(e.validFrom), to: e.validTo ? isoFromDate(e.validTo) : null, weeklyHours: e.weeklyHours.toString() }))
    .filter((e) => e.from <= toIso && (e.to === null || e.to >= fromIso));
}

/** Aktive Mitarbeiter mit mindestens einem Beschäftigungsverhältnis im Zeitraum (für Vollständigkeitsprüfungen, z. B. Lohn-Export). */
export async function employeesEmployedIn(tx: Tx, organizationId: string, fromIso: string, toIso: string) {
  const rows = await tx.employee.findMany({
    where: {
      organizationId, active: true,
      employments: { some: { validFrom: { lte: new Date(`${toIso}T00:00:00Z`) }, OR: [{ validTo: null }, { validTo: { gte: new Date(`${fromIso}T00:00:00Z`) } }] } },
    },
    select: { id: true, number: true, firstName: true, lastName: true },
    orderBy: { number: "asc" },
  });
  return rows;
}

/** Genehmigte Abwesenheitstage (Mo–Fr ohne Feiertag) je Art im Monat, am Monatsrand abgeschnitten. */
export async function absenceDaysByType(tx: Tx, organizationId: string, employeeId: string, year: number, month: number) {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const rows = await tx.absenceRequest.findMany({
    where: { organizationId, employeeId, status: "APPROVED", startDate: { lte: new Date(`${last}T00:00:00Z`) }, endDate: { gte: new Date(`${first}T00:00:00Z`) } },
    select: { startDate: true, endDate: true, type: { select: { key: true } } },
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    const from = isoFromDate(r.startDate) < first ? first : isoFromDate(r.startDate);
    const to = isoFromDate(r.endDate) > last ? last : isoFromDate(r.endDate);
    out[r.type.key] = (out[r.type.key] ?? 0) + countWorkingDays(from, to);
  }
  return out;
}
