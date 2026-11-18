import { describe, expect, it } from "vitest";
import { daysUntil, nextDue } from "./rules";

describe("Wartungsintervalle", () => {
  it("Tage über Monats- und Jahresgrenzen", () => {
    expect(nextDue("2027-01-15", "DAYS", 30)).toBe("2027-02-14");
    expect(nextDue("2027-12-20", "DAYS", 14)).toBe("2028-01-03");
    expect(nextDue("2028-02-28", "DAYS", 1)).toBe("2028-02-29"); // Schaltjahr
  });
  it("Monate halten das Monatsende ein", () => {
    expect(nextDue("2027-01-31", "MONTHS", 1)).toBe("2027-02-28");
    expect(nextDue("2028-01-31", "MONTHS", 1)).toBe("2028-02-29");
    expect(nextDue("2027-03-15", "MONTHS", 12)).toBe("2028-03-15");
    expect(nextDue("2027-11-30", "MONTHS", 3)).toBe("2028-02-29");
    expect(nextDue("2027-08-31", "MONTHS", 6)).toBe("2028-02-29");
  });
  it("ungültige Intervalle", () => {
    expect(() => nextDue("2027-01-01", "DAYS", 0)).toThrow();
    expect(() => nextDue("2027-01-01", "MONTHS", 1.5)).toThrow();
  });
  it("Tage bis zur Fälligkeit", () => {
    expect(daysUntil("2027-03-10", "2027-03-01")).toBe(9);
    expect(daysUntil("2027-03-01", "2027-03-10")).toBe(-9);
    expect(daysUntil("2027-03-01", "2027-03-01")).toBe(0);
  });
});
