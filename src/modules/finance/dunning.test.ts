import { describe, expect, it } from "vitest";
import { addDaysIso, bucketOf, daysBetween, nextDunning } from "./dunning";

describe("Mahnregeln", () => {
  it("rechnet Tage über Monats- und Jahresgrenzen", () => {
    expect(daysBetween("2027-01-31", "2027-03-01")).toBe(29);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(daysBetween("2027-03-10", "2027-03-01")).toBe(-9);
    expect(addDaysIso("2027-02-25", 7)).toBe("2027-03-04");
  });
  it("ordnet die Alterung zu", () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual(["NOT_DUE", "NOT_DUE", "D1_30", "D1_30", "D31_60", "D31_60", "D61_90", "D61_90", "D90_PLUS"]);
  });
  it("erste Stufe erst nach Fälligkeit", () => {
    expect(nextDunning({ dueDate: "2027-03-10", today: "2027-03-10", lastLevel: 0 })).toMatchObject({ allowed: false });
    expect(nextDunning({ dueDate: "2027-03-10", today: "2027-03-11", lastLevel: 0 })).toEqual({ allowed: true, level: 1 });
  });
  it("Folgestufen nur mit Mindestabstand und höchstens bis Stufe 3", () => {
    expect(nextDunning({ dueDate: "2027-01-01", today: "2027-03-01", lastLevel: 1, lastNoticeOn: "2027-02-20" })).toMatchObject({ allowed: false });
    expect(nextDunning({ dueDate: "2027-01-01", today: "2027-03-01", lastLevel: 1, lastNoticeOn: "2027-02-15" })).toEqual({ allowed: true, level: 2 });
    expect(nextDunning({ dueDate: "2027-01-01", today: "2027-04-01", lastLevel: 3, lastNoticeOn: "2027-02-01" })).toMatchObject({ allowed: false });
  });
});
