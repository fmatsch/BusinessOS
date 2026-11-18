import { describe, expect, it } from "vitest";
import { checkPerson, checkShiftDefinition, checkStaffing, DEFAULT_RULES, hasErrors, workMinutes, type Span } from "./rules";
import { shiftInstants } from "./timezone";

const TZ = "Europe/Vienna";
let n = 0;
function span(date: string, from: string, to: string, breakMinutes = 30): Span {
  const { startAt, endAt } = shiftInstants(date, from, to, TZ);
  return { shiftId: `s${++n}`, start: startAt, end: endAt, breakMinutes };
}
const codes = (v: { code: string }[]) => v.map((x) => x.code).sort();

describe("Schichtdefinition", () => {
  it("gültige Schicht (8 h, 30 min Pause) hat keine Verstöße", () => {
    expect(checkShiftDefinition(span("2027-05-10", "08:00", "16:30"), DEFAULT_RULES)).toEqual([]);
  });
  it("Pause: genau 6 h ohne Pause ok, darüber Pause nötig", () => {
    expect(checkShiftDefinition(span("2027-05-10", "08:00", "14:00", 0), DEFAULT_RULES)).toEqual([]);
    expect(codes(checkShiftDefinition(span("2027-05-10", "08:00", "14:01", 0), DEFAULT_RULES))).toEqual(["BREAK"]);
    expect(codes(checkShiftDefinition(span("2027-05-10", "08:00", "16:00", 29), DEFAULT_RULES))).toEqual(["BREAK"]);
  });
  it("Höchstarbeitszeit 12 h netto: 12 h ok, 12 h 1 min nicht", () => {
    expect(checkShiftDefinition(span("2027-05-10", "06:00", "18:30", 30), DEFAULT_RULES)).toEqual([]);
    expect(codes(checkShiftDefinition(span("2027-05-10", "06:00", "18:31", 30), DEFAULT_RULES))).toEqual(["MAX_DAILY"]);
  });
  it("ungültig: Dauer 0, Pause ≥ Dauer", () => {
    // Ende = Beginn bedeutet 24 h (Folgetag): zu lang und ohne Pause
    expect(codes(checkShiftDefinition(span("2027-05-10", "08:00", "08:00", 0), DEFAULT_RULES))).toEqual(["BREAK", "MAX_DAILY"]);
    const s = span("2027-05-10", "08:00", "09:00", 60);
    expect(codes(checkShiftDefinition(s, DEFAULT_RULES))).toEqual(["INVALID_SHIFT"]);
  });
  it("Nettoarbeitszeit abzüglich Pause", () => {
    expect(workMinutes(span("2027-05-10", "08:00", "16:30", 30))).toBe(480);
  });
});

describe("Person über mehrere Schichten", () => {
  it("11 h Tagesruhe: genau 11 h ok, 10 h 59 min nicht", () => {
    const ok = [span("2027-05-10", "14:00", "22:00"), span("2027-05-11", "09:00", "17:00")]; // 11 h Pause
    expect(checkPerson(ok, DEFAULT_RULES, TZ)).toEqual([]);
    const bad = [span("2027-05-10", "14:00", "22:00"), span("2027-05-11", "08:59", "16:59")];
    expect(codes(checkPerson(bad, DEFAULT_RULES, TZ))).toEqual(["REST_DAILY"]);
  });
  it("Spätdienst → Frühdienst verletzt die Tagesruhe, Nachtschicht über Mitternacht zählt ab Schichtende", () => {
    const v = checkPerson([span("2027-05-10", "22:00", "06:00"), span("2027-05-11", "14:00", "20:00")], DEFAULT_RULES, TZ);
    expect(codes(v)).toEqual(["REST_DAILY"]); // 8 h Pause
  });
  it("Überschneidung ist Doppelbuchung (auch mit früherer langer Schicht)", () => {
    const long = span("2027-05-10", "06:00", "18:00");
    const inside = span("2027-05-10", "08:00", "10:00", 0);
    const after = span("2027-05-10", "17:00", "19:00", 0);
    const v = checkPerson([long, inside, after], DEFAULT_RULES, TZ);
    expect(v.filter((x) => x.code === "DOUBLE_BOOKING").length).toBe(2);
    expect(hasErrors(v)).toBe(true);
  });
  it("Tagesarbeitszeit über mehrere Schichten desselben Tages wird summiert", () => {
    const v = checkPerson([span("2027-05-10", "05:00", "11:00", 30), span("2027-05-10", "22:30", "23:59", 0)], DEFAULT_RULES, TZ);
    expect(codes(v)).not.toContain("MAX_DAILY"); // 5,5 h + 1,5 h
    const heavy = checkPerson([span("2027-05-10", "00:00", "07:00", 30), span("2027-05-10", "16:00", "23:00", 30)], DEFAULT_RULES, TZ);
    expect(codes(heavy)).toContain("MAX_DAILY"); // 6,5 h + 6,5 h = 13 h am selben Tag
  });
  it("Wochenarbeitszeit: 60 h ok, mehr nicht", () => {
    const week = (hoursPerDay: number, days: number) =>
      Array.from({ length: days }, (_, i) => span(`2027-05-${String(10 + i).padStart(2, "0")}`, "07:00", `${String(7 + hoursPerDay).padStart(2, "0")}:30`, 30));
    expect(codes(checkPerson(week(10, 6), DEFAULT_RULES, TZ))).not.toContain("MAX_WEEKLY"); // 6 × 10 h = 60 h
    expect(codes(checkPerson(week(11, 6), DEFAULT_RULES, TZ))).toContain("MAX_WEEKLY"); // 66 h
  });
  it("Wochenruhe: 7 Tage am Stück warnt, ein freier Tag mit 36 h Pause nicht", () => {
    const seven = Array.from({ length: 7 }, (_, i) => span(`2027-05-${String(10 + i).padStart(2, "0")}`, "08:00", "12:00", 0));
    const w = checkPerson(seven, DEFAULT_RULES, TZ);
    expect(w.some((x) => x.code === "WEEKLY_REST" && x.severity === "WARNING")).toBe(true);
    expect(hasErrors(w)).toBe(false); // nur Warnung
    const six = seven.slice(0, 5); // Mo–Fr
    expect(codes(checkPerson(six, DEFAULT_RULES, TZ))).not.toContain("WEEKLY_REST");
  });
  it("Regeln sind je Organisation überschreibbar", () => {
    const strict = { ...DEFAULT_RULES, restDailyMinutes: 12 * 60 };
    const spans = [span("2027-05-10", "14:00", "22:00"), span("2027-05-11", "09:00", "17:00")];
    expect(checkPerson(spans, DEFAULT_RULES, TZ)).toEqual([]);
    expect(codes(checkPerson(spans, strict, TZ))).toEqual(["REST_DAILY"]);
  });
  it("Zeitumstellung: Nachtschicht in der Umstellungsnacht zählt 7 h Arbeitszeit statt 8 h", () => {
    const s = span("2027-03-27", "22:00", "06:00", 0);
    expect(workMinutes(s)).toBe(7 * 60);
  });
});

describe("Besetzung", () => {
  it("unter-/überbesetzt sind Warnungen", () => {
    expect(checkStaffing("s", 2, 1)[0]).toMatchObject({ code: "UNDERSTAFFED", severity: "WARNING" });
    expect(checkStaffing("s", 1, 2)[0]).toMatchObject({ code: "OVERSTAFFED", severity: "WARNING" });
    expect(checkStaffing("s", 2, 2)).toEqual([]);
  });
});
