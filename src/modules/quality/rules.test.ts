import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { decisionProblem, evaluate, outcome } from "./rules";

const D = (v: string) => new Decimal(v);
const q = (min: string | null, max: string | null) => ({ kind: "QUANTITATIVE", minValue: min ? D(min) : null, maxValue: max ? D(max) : null });

describe("Prüfregeln", () => {
  it("Messwerte: Grenzen sind eingeschlossen, einseitige Grenzen möglich", () => {
    expect(evaluate(q("9.9", "10.1"), { value: D("10") })).toMatchObject({ passed: true });
    expect(evaluate(q("9.9", "10.1"), { value: D("9.9") })).toMatchObject({ passed: true });
    expect(evaluate(q("9.9", "10.1"), { value: D("10.1") })).toMatchObject({ passed: true });
    expect(evaluate(q("9.9", "10.1"), { value: D("10.11") })).toMatchObject({ passed: false });
    expect(evaluate(q("9.9", "10.1"), { value: D("9.89") })).toMatchObject({ passed: false });
    expect(evaluate(q(null, "5"), { value: D("-100") })).toMatchObject({ passed: true });
    expect(evaluate(q("5", null), { value: D("4.999") })).toMatchObject({ passed: false });
  });
  it("unvollständige oder unpassende Eingaben werden gemeldet", () => {
    expect(evaluate(q("1", "2"), {})).toEqual({ error: "Bitte einen Messwert angeben" });
    expect(evaluate({ kind: "QUALITATIVE", minValue: null, maxValue: null }, {})).toMatchObject({ error: expect.stringMatching(/in Ordnung/) });
    expect(evaluate({ kind: "QUALITATIVE", minValue: null, maxValue: null }, { passed: true, value: D("1") })).toMatchObject({ error: expect.stringMatching(/keinen Messwert/) });
    expect(evaluate({ kind: "QUALITATIVE", minValue: null, maxValue: null }, { passed: false })).toEqual({ passed: false, value: null });
    expect(evaluate(q("1", "2"), { value: D("NaN") })).toMatchObject({ error: expect.stringMatching(/Ungültig/) });
  });
  it("Gesamtergebnis und Entscheid", () => {
    const partial = outcome(3, [{ passed: true }, { passed: true }]);
    expect(partial).toEqual({ complete: false, failed: 0, allPassed: true });
    expect(decisionProblem(partial, "ACCEPT", null, false)).toMatch(/alle Merkmale/);
    const good = outcome(2, [{ passed: true }, { passed: true }]);
    expect(decisionProblem(good, "ACCEPT", null, false)).toBeNull();
    expect(decisionProblem(good, "REJECT", "x", false)).toMatch(/nicht möglich/);
    expect(decisionProblem(good, "ACCEPT", "grundlos", true)).toMatch(/nur bei nicht bestandenen/);
    const bad = outcome(2, [{ passed: true }, { passed: false }]);
    expect(decisionProblem(bad, "ACCEPT", null, false)).toMatch(/Sonderfreigabe/);
    expect(decisionProblem(bad, "ACCEPT", "kurz", true)).toMatch(/Begründung/);
    expect(decisionProblem(bad, "ACCEPT", "Kunde akzeptiert Toleranz", true)).toBeNull();
    expect(decisionProblem(bad, "REJECT", null, false)).toBeNull();
    expect(outcome(0, []).complete).toBe(false);
  });
});
