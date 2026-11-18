import { describe, expect, it } from "vitest";
import { computeTotal, requiredSteps } from "./rules";

describe("computeTotal", () => {
  it("rechnet ohne Gleitkommafehler", () => {
    const t = computeTotal([
      { quantity: "3", unitPrice: "0.1" },
      { quantity: "1", unitPrice: "0.2" },
    ]);
    expect(t.toString()).toBe("0.5");
  });
});

describe("requiredSteps", () => {
  it("genau 5.000 braucht nur die Führungskraft", () => {
    expect(requiredSteps("5000")).toEqual(["MANAGER"]);
  });
  it("über 5.000 braucht zusätzlich Finanzen", () => {
    expect(requiredSteps("5000.01")).toEqual(["MANAGER", "FINANCE"]);
  });
});
