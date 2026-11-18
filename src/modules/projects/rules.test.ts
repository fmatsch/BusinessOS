import { describe, expect, it } from "vitest";
import { billingNet, bookingDateProblem, budgetUsedPercent, hoursToMinutes, minutesToHours } from "./rules";

describe("Projektstunden: Regeln", () => {
  it("rechnet Stunden und Minuten exakt und kaufmännisch gerundet", () => {
    expect(hoursToMinutes("1.5")).toBe(90);
    expect(hoursToMinutes("0.25")).toBe(15);
    expect(hoursToMinutes("7.99")).toBe(479);
    expect(minutesToHours(90).toString()).toBe("1.5");
    expect(minutesToHours(20).toString()).toBe("0.33"); // 0,3333… → 0,33
    expect(minutesToHours(35).toString()).toBe("0.58"); // 0,5833… → 0,58
  });
  it("Nettobetrag = gerundete Stunden × Satz (wie auf der Rechnung)", () => {
    expect(billingNet(90, "120").toString()).toBe("180");
    expect(billingNet(20, "100").toString()).toBe("33"); // 0,33 h × 100
    expect(billingNet(35, "85.5").toString()).toBe("49.59"); // 0,58 × 85,5 = 49,59
  });
  it("Budgetverbrauch in Prozent", () => {
    expect(budgetUsedPercent(300, "10")).toBe(50);
    expect(budgetUsedPercent(660, "10")).toBe(110);
    expect(budgetUsedPercent(60, null)).toBeNull();
    expect(budgetUsedPercent(60, "0")).toBeNull();
  });
  it("Buchungsdatum: nicht Zukunft, innerhalb des Projektzeitraums", () => {
    expect(bookingDateProblem("2027-03-02", "2027-03-01")).toMatch(/Zukunft/);
    expect(bookingDateProblem("2027-02-28", "2027-03-01", "2027-03-01")).toMatch(/beginnt/);
    expect(bookingDateProblem("2027-03-01", "2027-03-05", null, "2027-02-28")).toMatch(/endete/);
    expect(bookingDateProblem("2027-03-01", "2027-03-05", "2027-03-01", "2027-03-01")).toBeNull();
  });
});
