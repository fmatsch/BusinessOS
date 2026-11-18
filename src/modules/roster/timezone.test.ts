import { describe, expect, it } from "vitest";
import { isValidTimeZone, localDateOf, localParts, mondayOf, NonexistentLocalTimeError, offsetMinutes, shiftInstants, zonedToUtc } from "./timezone";

const VIE = "Europe/Vienna";
const iso = (d: Date) => d.toISOString();
const hoursOf = (s: { startAt: Date; endAt: Date }) => (s.endAt.getTime() - s.startAt.getTime()) / 3_600_000;

describe("Zeitzonen", () => {
  it("Versatz Wien: Winter +60, Sommer +120", () => {
    expect(offsetMinutes(new Date("2027-01-15T12:00:00Z"), VIE)).toBe(60);
    expect(offsetMinutes(new Date("2027-07-15T12:00:00Z"), VIE)).toBe(120);
  });
  it("Ortszeit → UTC (Winter/Sommer, andere Zonen)", () => {
    expect(iso(zonedToUtc("2027-01-15", "08:00", VIE))).toBe("2027-01-15T07:00:00.000Z");
    expect(iso(zonedToUtc("2027-07-15", "08:00", VIE))).toBe("2027-07-15T06:00:00.000Z");
    expect(iso(zonedToUtc("2027-01-15", "08:00", "America/New_York"))).toBe("2027-01-15T13:00:00.000Z");
    expect(iso(zonedToUtc("2027-01-15", "08:00", "Asia/Kolkata"))).toBe("2027-01-15T02:30:00.000Z"); // +05:30
  });
  it("Umstellung auf Sommerzeit 28.3.2027: 02:30 existiert nicht", () => {
    expect(() => zonedToUtc("2027-03-28", "02:30", VIE)).toThrow(NonexistentLocalTimeError);
    expect(iso(zonedToUtc("2027-03-28", "03:00", VIE))).toBe("2027-03-28T01:00:00.000Z");
    expect(iso(zonedToUtc("2027-03-28", "01:59", VIE))).toBe("2027-03-28T00:59:00.000Z");
  });
  it("Umstellung auf Winterzeit 31.10.2027: 02:30 kommt zweimal vor, der frühere Zeitpunkt gilt", () => {
    expect(iso(zonedToUtc("2027-10-31", "02:30", VIE))).toBe("2027-10-31T00:30:00.000Z"); // noch Sommerzeit
    expect(iso(zonedToUtc("2027-10-31", "03:00", VIE))).toBe("2027-10-31T02:00:00.000Z");
  });
  it("Nachtschicht 22:00–06:00 dauert 7 h in der Nacht der Sommerzeit-Umstellung, 9 h bei Winterzeit-Umstellung, sonst 8 h", () => {
    expect(hoursOf(shiftInstants("2027-03-27", "22:00", "06:00", VIE))).toBe(7);
    expect(hoursOf(shiftInstants("2027-10-30", "22:00", "06:00", VIE))).toBe(9);
    expect(hoursOf(shiftInstants("2027-05-10", "22:00", "06:00", VIE))).toBe(8);
  });
  it("Ende vor oder gleich Beginn liegt am Folgetag; Tagschicht bleibt am selben Tag", () => {
    const night = shiftInstants("2027-05-10", "22:00", "06:00", VIE);
    expect(localDateOf(night.endAt, VIE)).toBe("2027-05-11");
    const day = shiftInstants("2027-05-10", "08:00", "16:00", VIE);
    expect(localDateOf(day.endAt, VIE)).toBe("2027-05-10");
    expect(hoursOf(shiftInstants("2027-05-10", "08:00", "08:00", VIE))).toBe(24);
  });
  it("localParts liefert Ortsdatum und Minuten; Mitternacht in Wien liegt vor 24:00 UTC", () => {
    expect(localParts(new Date("2027-05-10T22:30:00Z"), VIE)).toMatchObject({ date: "2027-05-11", minutes: 30 });
  });
  it("Zeitzonenvalidierung und Montag der Woche", () => {
    expect(isValidTimeZone("Europe/Vienna")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(mondayOf("2027-03-07")).toBe("2027-03-01"); // Sonntag -> Montag davor
    expect(mondayOf("2027-03-01")).toBe("2027-03-01");
    expect(mondayOf("2027-01-01")).toBe("2026-12-28"); // über Jahresgrenze
  });
});
