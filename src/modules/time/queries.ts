import type { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export interface PeriodSnapshot {
  workedMinutes: number;
  targetMinutes: number;
  categories: { night: number; sunday: number; holiday: number };
  days: { flag: string | null }[];
}

/** Monatsabschlüsse eines Monats mit dem Stand zum Zeitpunkt der Freigabe (für Lohn-Export und Auswertungen). */
export async function periodsOf(tx: Tx, organizationId: string, year: number, month: number) {
  const rows = await tx.timesheetPeriod.findMany({ where: { organizationId, year, month } });
  return rows.map((p) => ({ employeeId: p.employeeId, status: p.status, summary: (p.summary as unknown as PeriodSnapshot | null) ?? null }));
}

export const DEFAULT_PAY_CODES = { NIGHT: 25, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 } as const;

/** Zuschlagsprozente der Organisation (Konfiguration, Voreinstellung falls nichts hinterlegt). */
export async function payCodePercents(tx: Tx, organizationId: string) {
  const rows = await tx.payCodeRule.findMany({ where: { organizationId } });
  const out: { NIGHT: number; SUNDAY: number; HOLIDAY: number; OVERTIME: number } = { ...DEFAULT_PAY_CODES };
  for (const r of rows) if (r.kind in out) out[r.kind as keyof typeof out] = Number(r.percent.toString());
  return out;
}
