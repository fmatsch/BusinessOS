import { Decimal } from "@/lib/money";

/** Prüfregeln (rein, ohne Datenbank). */

export interface CharSpec { kind: string; minValue: Decimal | null; maxValue: Decimal | null }
export interface Measurement { value?: Decimal | null; passed?: boolean | null }

/**
 * Bewertet ein Merkmal. Messwerte müssen innerhalb der Grenzen (einschließlich) liegen; qualitative Merkmale brauchen eine Angabe „in Ordnung / nicht in Ordnung“.
 * Gibt `{ error }` bei unvollständiger oder unpassender Eingabe zurück.
 */
export function evaluate(spec: CharSpec, m: Measurement): { passed: boolean; value: Decimal | null } | { error: string } {
  if (spec.kind === "QUALITATIVE") {
    if (m.passed === undefined || m.passed === null) return { error: "Bitte „in Ordnung“ oder „nicht in Ordnung“ angeben" };
    if (m.value !== undefined && m.value !== null) return { error: "Qualitative Merkmale haben keinen Messwert" };
    return { passed: m.passed, value: null };
  }
  if (m.value === undefined || m.value === null) return { error: "Bitte einen Messwert angeben" };
  if (!m.value.isFinite()) return { error: "Ungültiger Messwert" };
  const ok = (spec.minValue === null || m.value.gte(spec.minValue)) && (spec.maxValue === null || m.value.lte(spec.maxValue));
  return { passed: ok, value: m.value };
}

export interface Outcome { complete: boolean; failed: number; allPassed: boolean }
/** Gesamtergebnis eines Prüfloses: vollständig, wenn zu jedem Merkmal ein Ergebnis vorliegt. */
export function outcome(expectedCharacteristics: number, results: { passed: boolean }[]): Outcome {
  const failed = results.filter((r) => !r.passed).length;
  return { complete: expectedCharacteristics > 0 && results.length === expectedCharacteristics, failed, allPassed: failed === 0 };
}

/**
 * Entscheid zulässig? Annahme nur bei vollständiger Prüfung; mit nicht bestandenen Merkmalen nur als Sonderfreigabe mit Begründung.
 * Ablehnung braucht ebenfalls vollständige Ergebnisse, außer bei begründetem Abbruch.
 */
export function decisionProblem(o: Outcome, decision: "ACCEPT" | "REJECT", note: string | null, deviation: boolean): string | null {
  if (!o.complete) return "Es müssen zuerst alle Merkmale geprüft werden";
  if (decision === "ACCEPT" && !o.allPassed && !deviation) return `${o.failed} Merkmal(e) nicht bestanden – Annahme nur als Sonderfreigabe mit Begründung`;
  if (decision === "ACCEPT" && !o.allPassed && (note ?? "").trim().length < 5) return "Die Sonderfreigabe braucht eine Begründung";
  if (decision === "REJECT" && o.allPassed) return "Alle Merkmale bestanden – ein Ablehnen ist nicht möglich";
  if (decision === "ACCEPT" && o.allPassed && deviation) return "Sonderfreigabe nur bei nicht bestandenen Merkmalen";
  return null;
}
