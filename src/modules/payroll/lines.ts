/**
 * Lohn-Export: Ableitung der Exportzeilen aus freigegebenen Monaten. Reine Funktionen – keine Lohnberechnung (kein Brutto/Netto,
 * keine Steuern oder Sozialversicherung). Ausgegeben werden erfasste Mengen je Lohnart; die Bewertung übernimmt die Lohnverrechnung.
 */

export const WAGE_TYPES = ["NORMAL", "MEHRZEIT", "NIGHT", "SUNDAY", "HOLIDAY", "VACATION", "SICK", "CARE", "SPECIAL"] as const;
export type WageType = (typeof WAGE_TYPES)[number];

export const WAGE_LABEL: Record<WageType, string> = {
  NORMAL: "Normalarbeitszeit", MEHRZEIT: "Mehrzeit über Soll", NIGHT: "Nachtarbeit (Zuschlagsbasis)", SUNDAY: "Sonntagsarbeit (Zuschlagsbasis)",
  HOLIDAY: "Feiertagsarbeit (Zuschlagsbasis)", VACATION: "Urlaub", SICK: "Krankenstand", CARE: "Pflegefreistellung", SPECIAL: "Sonderurlaub",
};

/** Abwesenheitsarten werden in Arbeitstagen ausgegeben, alles andere in Minuten. */
export const ABSENCE_WAGE_TYPES = ["VACATION", "SICK", "CARE", "SPECIAL"] as const;
export type AbsenceWageType = (typeof ABSENCE_WAGE_TYPES)[number];
export const unitOf = (w: WageType): "MINUTES" | "DAYS" => ((ABSENCE_WAGE_TYPES as readonly string[]).includes(w) ? "DAYS" : "MINUTES");

export interface PeriodFacts {
  workedMinutes: number;
  targetMinutes: number;
  night: number;
  sunday: number;
  holiday: number;
}

/**
 * Sollmengen je Lohnart für einen Monat.
 * NORMAL = Arbeitszeit bis zum Soll, MEHRZEIT = darüber. Nacht/Sonntag/Feiertag sind Teilmengen der Arbeitszeit (Basis für Zuschläge),
 * keine zusätzliche Arbeitszeit.
 */
export function desiredQuantities(f: PeriodFacts, absenceDays: Record<AbsenceWageType, number>): Record<WageType, number> {
  return {
    NORMAL: Math.max(0, Math.min(f.workedMinutes, f.targetMinutes)),
    MEHRZEIT: Math.max(0, f.workedMinutes - f.targetMinutes),
    NIGHT: f.night, SUNDAY: f.sunday, HOLIDAY: f.holiday,
    VACATION: absenceDays.VACATION, SICK: absenceDays.SICK, CARE: absenceDays.CARE, SPECIAL: absenceDays.SPECIAL,
  };
}

export interface LineDelta { wageType: WageType; quantity: number }

/** Differenz zwischen Soll und bereits exportierten Mengen (Nachtrag). Nur Abweichungen ≠ 0, in fester Lohnart-Reihenfolge. */
export function diffQuantities(desired: Record<WageType, number>, exported: Partial<Record<WageType, number>>): LineDelta[] {
  return WAGE_TYPES.map((w) => ({ wageType: w, quantity: desired[w] - (exported[w] ?? 0) })).filter((d) => d.quantity !== 0);
}

/** Zuschlagsprozent aus den Zuschlagsregeln (Konfiguration); Mehrzeit nutzt „OVERTIME". */
export function percentFor(w: WageType, rules: { NIGHT: number; SUNDAY: number; HOLIDAY: number; OVERTIME: number }): number | null {
  if (w === "NIGHT") return rules.NIGHT;
  if (w === "SUNDAY") return rules.SUNDAY;
  if (w === "HOLIDAY") return rules.HOLIDAY;
  if (w === "MEHRZEIT") return rules.OVERTIME;
  return null;
}
