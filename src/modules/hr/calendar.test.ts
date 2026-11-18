import { describe, expect, it } from "vitest";
import { addDays, austrianHolidays, countWorkingDays, daysBetween, easterSunday, isValidIsoDate, isWorkingDay, rangesOverlap, workingDaysByYear } from "./calendar";

describe("Ostern und Feiertage", () => {
  it.each([
    [2024, "2024-03-31"], [2025, "2025-04-20"], [2026, "2026-04-05"], [2027, "2027-03-28"], [2038, "2038-04-25"],
  ])("Ostersonntag %i", (year, expected) => expect(easterSunday(year)).toBe(expected));

  it("bewegliche Feiertage 2026 (Ostermontag, Himmelfahrt, Pfingstmontag, Fronleichnam)", () => {
    const h = austrianHolidays(2026);
    expect(h.get("2026-04-06")).toBe("Ostermontag");
    expect(h.get("2026-05-14")).toBe("Christi Himmelfahrt");
    expect(h.get("2026-05-25")).toBe("Pfingstmontag");
    expect(h.get("2026-06-04")).toBe("Fronleichnam");
  });
  it("13 gesetzliche Feiertage; Karfreitag, 24. und 31. Dezember sind keine", () => {
    const h = austrianHolidays(2026);
    expect(h.size).toBe(13);
    for (const d of ["2026-04-03", "2026-12-24", "2026-12-31"]) expect(h.has(d)).toBe(false);
  });
});

describe("Arbeitstage", () => {
  it("Wochenenden und Feiertage zählen nicht", () => {
    expect(isWorkingDay("2026-11-18")).toBe(true); // Mittwoch
    expect(isWorkingDay("2026-11-21")).toBe(false); // Samstag
    expect(isWorkingDay("2026-11-01")).toBe(false); // Allerheiligen (Sonntag)
    expect(isWorkingDay("2026-12-08")).toBe(false); // Mariä Empfängnis (Dienstag)
  });
  it("volle Woche = 5, mit Feiertag = 4", () => {
    expect(countWorkingDays("2026-11-16", "2026-11-22")).toBe(5);
    expect(countWorkingDays("2026-12-07", "2026-12-11")).toBe(4);
  });
  it("Osterwoche 2026 (Mo 30.3. – Fr 10.4.): 9 Arbeitstage wegen Ostermontag", () => {
    expect(countWorkingDays("2026-03-30", "2026-04-10")).toBe(9);
  });
  it("ein einzelner Tag, nur Wochenende = 0", () => {
    expect(countWorkingDays("2026-11-18", "2026-11-18")).toBe(1);
    expect(countWorkingDays("2026-11-21", "2026-11-22")).toBe(0);
  });
  it("Jahreswechsel wird je Jahr getrennt gezählt (23.12.2026 – 08.01.2027)", () => {
    // 2026: Mi 23., Do 24., Fr 25.(Christtag), Mo 28.–Do 31. => 23,24,28,29,30,31 = 6 (26.12. ist Samstag)
    // 2027: Fr 1.(Neujahr), Mo 4.–Do 7., Fr 8. => Di 5? Mo 4,Di 5,Mi 6(Hl. Drei Könige),Do 7,Fr 8 => 4,5,7,8 = 4
    const m = workingDaysByYear("2026-12-23", "2027-01-08");
    expect(m.get(2026)).toBe(6);
    expect(m.get(2027)).toBe(4);
  });
  it("Schaltjahr: 29.2.2028 ist ein Dienstag und ein Arbeitstag", () => {
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isWorkingDay("2028-02-29")).toBe(true);
  });
});

describe("Datumshilfen", () => {
  it("validiert ISO-Daten streng", () => {
    for (const bad of ["2026-02-29", "2026-13-01", "26-01-01", "2026-1-1", "", "2026-01-01T00:00"]) expect(isValidIsoDate(bad)).toBe(false);
    expect(isValidIsoDate("2026-02-28")).toBe(true);
  });
  it("addDays/daysBetween über Monats-, Jahres- und Sommerzeitgrenzen", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(3); // Zeitumstellung 29.3.
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(3); // Zeitumstellung 25.10.
  });
  it("Zeiträume überschneiden sich inklusive der Grenzen; offenes Ende", () => {
    expect(rangesOverlap("2026-01-01", "2026-01-05", "2026-01-05", "2026-01-10")).toBe(true);
    expect(rangesOverlap("2026-01-01", "2026-01-04", "2026-01-05", "2026-01-10")).toBe(false);
    expect(rangesOverlap("2026-01-01", "2026-01-04", "2025-01-01", null)).toBe(true);
  });
});
