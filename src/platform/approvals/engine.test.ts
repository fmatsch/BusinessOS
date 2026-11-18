import { describe, expect, it } from "vitest";
import { DEFAULT_PURCHASE_POLICY, policyStepsSchema, stepsFor } from "./engine";

describe("stepsFor", () => {
  it("Standardregel: genau 5.000 nur Führungskraft, darüber zusätzlich Finanzen", () => {
    expect(stepsFor(DEFAULT_PURCHASE_POLICY, "5000").map((s) => s.key)).toEqual(["MANAGER"]);
    expect(stepsFor(DEFAULT_PURCHASE_POLICY, "5000.01").map((s) => s.key)).toEqual(["MANAGER", "FINANCE"]);
    expect(stepsFor(DEFAULT_PURCHASE_POLICY, "0").map((s) => s.key)).toEqual(["MANAGER"]);
  });
  it("mehrere Schwellen werden in Reihenfolge angewandt", () => {
    const steps = policyStepsSchema.parse([
      { key: "A", label: "A", permission: "procurement.request.approve" },
      { key: "B", label: "B", permission: "procurement.request.approve_finance", minAmount: "1000" },
      { key: "C", label: "C", permission: "procurement.request.approve_finance", minAmount: "20000.5" },
    ]);
    expect(stepsFor(steps, "999.99").map((s) => s.key)).toEqual(["A"]);
    expect(stepsFor(steps, "1000.01").map((s) => s.key)).toEqual(["A", "B"]);
    expect(stepsFor(steps, "20000.5").map((s) => s.key)).toEqual(["A", "B"]);
    expect(stepsFor(steps, "20000.51").map((s) => s.key)).toEqual(["A", "B", "C"]);
  });
});

describe("policyStepsSchema", () => {
  const ok = { key: "A", label: "A", permission: "procurement.request.approve" };
  it("akzeptiert gültige Regeln", () => {
    expect(policyStepsSchema.safeParse([ok]).success).toBe(true);
    expect(policyStepsSchema.safeParse(DEFAULT_PURCHASE_POLICY).success).toBe(true);
  });
  it.each([
    ["leer", []],
    ["zu viele Schritte", Array.from({ length: 6 }, (_, i) => ({ ...ok, key: `K${i}` }))],
    ["erster Schritt mit Mindestbetrag (Vorgang ohne Freigabe möglich)", [{ ...ok, minAmount: "10" }]],
    ["doppelter Schlüssel", [ok, { ...ok, minAmount: "5" }]],
    ["ungültiger Schlüssel", [{ ...ok, key: "klein" }]],
    ["unzulässige Berechtigung", [{ ...ok, permission: "org.settings.manage" }]],
    ["negativer Betrag", [ok, { ...ok, key: "B", minAmount: "-5" }]],
    ["Betrag mit Exponent", [ok, { ...ok, key: "B", minAmount: "1e3" }]],
    ["zu viele Nachkommastellen", [ok, { ...ok, key: "B", minAmount: "1.00001" }]],
  ])("lehnt ab: %s", (_name, steps) => {
    expect(policyStepsSchema.safeParse(steps).success).toBe(false);
  });
});
