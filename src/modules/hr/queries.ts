import type { Prisma } from "@prisma/client";
import { isoFromDate } from "./calendar";

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
