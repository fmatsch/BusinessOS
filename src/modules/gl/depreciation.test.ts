import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { accumulatedDepreciation, assetTermsProblem, bookValue, monthlyDepreciation } from "./depreciation";

const t = { cost: "1000", residual: "0", lifeMonths: 3, acquiredOn: "2027-01-15" };

describe("Lineare Abschreibung", () => {
  it("monatsgenau ab dem Anschaffungsmonat; Rundungsrest im letzten Monat; vorher und nachher null", () => {
    expect(monthlyDepreciation(t, 2026, 12).toString()).toBe("0");
    expect(monthlyDepreciation(t, 2027, 1).toString()).toBe("333.33");
    expect(monthlyDepreciation(t, 2027, 2).toString()).toBe("333.33");
    expect(monthlyDepreciation(t, 2027, 3).toString()).toBe("333.34"); // Rest
    expect(monthlyDepreciation(t, 2027, 4).toString()).toBe("0");
  });
  it("Summe entspricht der Abschreibungsbasis (Kosten − Restwert), Buchwert am Ende = Restwert", () => {
    const x = { cost: "12345.67", residual: "345.67", lifeMonths: 37, acquiredOn: "2027-11-30" };
    let sum = new Decimal(0);
    for (let i = 0; i < 60; i++) sum = sum.plus(monthlyDepreciation(x, 2027 + Math.floor((10 + i) / 12), ((10 + i) % 12) + 1));
    expect(sum.toString()).toBe("12000");
    expect(bookValue(x, 2035, 12).toString()).toBe("345.67");
    expect(accumulatedDepreciation(x, 2027, 11).toString()).toBe(monthlyDepreciation(x, 2027, 11).toString());
  });
  it("Buchwert über die Zeit", () => {
    expect(bookValue(t, 2027, 1).toString()).toBe("666.67");
    expect(bookValue(t, 2027, 2).toString()).toBe("333.34");
    expect(bookValue(t, 2027, 3).toString()).toBe("0");
    expect(bookValue(t, 2026, 12).toString()).toBe("1000");
  });
  it("prüft Eingaben", () => {
    const ok = { cost: new Decimal("100"), residual: new Decimal("1"), lifeMonths: 12 };
    expect(assetTermsProblem(ok)).toBeNull();
    expect(assetTermsProblem({ ...ok, cost: new Decimal("0") })).toMatch(/Anschaffungskosten/);
    expect(assetTermsProblem({ ...ok, residual: new Decimal("100") })).toMatch(/Restwert/);
    expect(assetTermsProblem({ ...ok, lifeMonths: 0 })).toMatch(/Nutzungsdauer/);
    expect(assetTermsProblem({ ...ok, lifeMonths: 12.5 })).toMatch(/Nutzungsdauer/);
  });
});
