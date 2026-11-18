import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { annualTariff, avRate, calculateEmployee, DEFAULT_PARAMS_AT, paramsSchema, PayrollLimitError, type EmployeeInput } from "./calc";

const P = DEFAULT_PARAMS_AT;
const base = (o: Partial<Record<keyof EmployeeInput, unknown>> = {}): EmployeeInput => ({
  monthlyGross: new Decimal("3000"), regularExtra: new Decimal(0), special: new Decimal(0), marginal: false,
  allowanceMonthly: new Decimal(0), commuterMonthly: new Decimal(0), familyBonusChildren: 0, ...(o as object),
});

describe("Parametertabelle", () => {
  it("die mitgelieferten Werte entsprechen dem Schema", () => { expect(paramsSchema.safeParse(P).success).toBe(true); });
  it("lehnt fehlerhafte Werte ab", () => {
    expect(paramsSchema.safeParse({ ...P, employerLevies: { ...P.employerLevies, db: "abc" } }).success).toBe(false);
  });
});

describe("Tarif und Arbeitslosenversicherung", () => {
  it("Jahrestarif stufenweise", () => {
    expect(annualTariff(P, new Decimal("10000")).toString()).toBe("0");
    expect(annualTariff(P, new Decimal("21992")).toString()).toBe("1690.6");
    expect(annualTariff(P, new Decimal("29476.8")).toFixed(2)).toBe("3936.04");
  });
  it("AV-Staffel", () => {
    expect(avRate(P, new Decimal("2000"))).toBe("0");
    expect(avRate(P, new Decimal("2300"))).toBe("1");
    expect(avRate(P, new Decimal("2500"))).toBe("2");
    expect(avRate(P, new Decimal("9000"))).toBe("3");
  });
});

describe("Monatsabrechnung", () => {
  it("3000 brutto: SV, Lohnsteuer, Netto und Arbeitgeberkosten von Hand nachgerechnet", () => {
    const r = calculateEmployee(P, base());
    expect(r.svEmployee).toBe("543.60");
    expect(r.taxBase).toBe("2456.40");
    expect(r.tax).toBe("286.67"); // (3936,04 − 496) / 12
    expect(r.net).toBe("2169.73");
    expect(r.employerSv).toBe("630.90");
    expect(r.employerLevies).toBe("255.90");
    expect(r.employerCost).toBe("3886.80");
  });
  it("Nettoprobe: Brutto = Netto + SV + Steuer", () => {
    const r = calculateEmployee(P, base({ monthlyGross: new Decimal("4321.55"), regularExtra: new Decimal("200") }));
    expect(new Decimal(r.net).plus(r.svEmployee).plus(r.tax).toFixed(2)).toBe(r.gross);
  });
  it("Familienbonus, Freibetrag und Pendlerpauschale mindern die Steuer; Steuer wird nie negativ", () => {
    const plain = calculateEmployee(P, base());
    expect(new Decimal(calculateEmployee(P, base({ familyBonusChildren: 1 })).tax).lt(plain.tax)).toBe(true);
    expect(new Decimal(calculateEmployee(P, base({ allowanceMonthly: new Decimal(100), commuterMonthly: new Decimal(50) })).tax).lt(plain.tax)).toBe(true);
    expect(calculateEmployee(P, base({ familyBonusChildren: 5 })).tax).toBe("0.00");
    expect(calculateEmployee(P, base({ monthlyGross: new Decimal("1000") })).tax).toBe("0.00");
  });
  it("Höchstbeitragsgrundlage", () => {
    const r = calculateEmployee(P, base({ monthlyGross: new Decimal("9000") }));
    expect(r.warnings).toContain("Höchstbeitragsgrundlage erreicht");
    const cap = calculateEmployee(P, base({ monthlyGross: new Decimal("6450") }));
    expect(r.svEmployee).toBe(cap.svEmployee);
  });
  it("sonstiger Bezug: eigene SV-Sätze und 6 % nach Freibetrag", () => {
    const r = calculateEmployee(P, base({ special: new Decimal("3000") }));
    expect(r.svEmployeeBreakdown["Sonderzahlung"]).toBe("519.60");
    expect(r.taxSpecial).toBe("111.62");
    expect(r.taxRegular).toBe("286.67");
  });
  it("sonstiger Bezug unter der Freigrenze bleibt steuerfrei; über dem Sechstel wird abgewiesen", () => {
    expect(calculateEmployee(P, base({ special: new Decimal("1000") })).taxSpecial).toBe("0.00");
    expect(() => calculateEmployee(P, base({ special: new Decimal("9000") }))).toThrow(PayrollLimitError);
  });
  it("geringfügig: keine Arbeitnehmer-SV, Pauschale für den Arbeitgeber; darüber voll versichert mit Hinweis", () => {
    const m = calculateEmployee(P, base({ monthlyGross: new Decimal("500"), marginal: true }));
    expect(m.svEmployee).toBe("0.00");
    expect(m.net).toBe("500.00");
    expect(m.employerSv).toBe("82.00");
    expect(m.employerLevies).toBe("0.00");
    const over = calculateEmployee(P, base({ monthlyGross: new Decimal("900"), marginal: true }));
    expect(over.warnings.join()).toMatch(/Geringfügigkeitsgrenze/);
    expect(new Decimal(over.svEmployee).gt(0)).toBe(true);
  });
  it("negative Beträge werden abgewiesen", () => {
    expect(() => calculateEmployee(P, base({ regularExtra: new Decimal("-1") }))).toThrow(PayrollLimitError);
  });
});
