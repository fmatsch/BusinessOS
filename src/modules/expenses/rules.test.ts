import { describe, expect, it } from "vitest";
import { canTransition, lineDateProblem, mileageAmount, sumAmounts } from "./rules";

describe("Spesen: Regeln", () => {
  it("Kilometergeld exakt gerundet", () => {
    expect(mileageAmount("120", "0.50").toString()).toBe("60");
    expect(mileageAmount("33.3", "0.42").toString()).toBe("13.99"); // 13,986
    expect(mileageAmount("0.01", "0.50").toString()).toBe("0.01"); // 0,005 → 0,01
  });
  it("Summen ohne Gleitkomma-Fehler", () => {
    expect(sumAmounts(["0.1", "0.2", "10.15"]).toString()).toBe("10.45");
    expect(sumAmounts([]).toString()).toBe("0");
  });
  it("Statusübergänge: nur der vorgesehene Ablauf", () => {
    expect(canTransition("DRAFT", "SUBMITTED")).toBe(true);
    expect(canTransition("SUBMITTED", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "PAID")).toBe(true);
    expect(canTransition("DRAFT", "PAID")).toBe(false);
    expect(canTransition("APPROVED", "CANCELLED")).toBe(false); // freigegebene werden nicht zurückgezogen
    for (const end of ["REJECTED", "PAID", "CANCELLED"] as const) expect(canTransition(end, "DRAFT")).toBe(false);
  });
  it("Datum: nicht Zukunft, innerhalb der Reise", () => {
    expect(lineDateProblem("2027-03-02", "2027-03-01")).toMatch(/Zukunft/);
    expect(lineDateProblem("2027-02-27", "2027-03-01", "2027-02-28")).toMatch(/vor dem Reisebeginn/);
    expect(lineDateProblem("2027-03-01", "2027-03-05", "2027-02-28", "2027-02-28")).toMatch(/nach dem Reiseende/);
    expect(lineDateProblem("2027-02-28", "2027-03-05", "2027-02-28", "2027-02-28")).toBeNull();
  });
});
