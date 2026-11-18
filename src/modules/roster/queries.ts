import type { Prisma } from "@prisma/client";
import { DEFAULT_RULES, type RuleParams } from "./rules";
import { localDateOf } from "./timezone";

// Öffentliche Schnittstelle der Dienstplanung für andere Module (z. B. Zeiterfassung)
export { checkPerson, checkShiftDefinition, DEFAULT_RULES, hasErrors, workMinutes } from "./rules";
export type { RuleParams, Span, Violation } from "./rules";
export { addDaysIso, localDateOf, localParts, mondayOf, offsetMinutes, zonedToUtc } from "./timezone";

type Tx = Prisma.TransactionClient;

/** Arbeitszeitregeln der Organisation (Voreinstellung, falls nichts hinterlegt ist). */
export async function loadRules(tx: Tx, organizationId: string): Promise<RuleParams> {
  const r = await tx.rosterRules.findUnique({ where: { organizationId } });
  return r
    ? { restDailyMinutes: r.restDailyMinutes, maxDailyMinutes: r.maxDailyMinutes, maxWeeklyMinutes: r.maxWeeklyMinutes, breakAfterMinutes: r.breakAfterMinutes, minBreakMinutes: r.minBreakMinutes, weeklyRestMinutes: r.weeklyRestMinutes }
    : DEFAULT_RULES;
}

/** Geplante Nettoarbeitszeit je Ortsdatum laut veröffentlichtem Dienstplan. */
export async function plannedMinutesByDay(tx: Tx, organizationId: string, employeeId: string, from: Date, to: Date, tz: string): Promise<Map<string, number>> {
  const rows = await tx.publishedShift.findMany({ where: { organizationId, employeeId, startAt: { gte: from, lt: to } }, select: { startAt: true, endAt: true, breakMinutes: true } });
  const map = new Map<string, number>();
  for (const r of rows) {
    const day = localDateOf(r.startAt, tz);
    map.set(day, (map.get(day) ?? 0) + Math.round((r.endAt.getTime() - r.startAt.getTime()) / 60_000) - r.breakMinutes);
  }
  return map;
}
