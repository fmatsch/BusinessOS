import { describe, expect, it } from "vitest";
import { buildIcs, fold } from "./ical";

describe("iCalendar", () => {
  const now = new Date("2027-05-01T10:00:00Z");
  it("erzeugt gültiges VCALENDAR mit UTC-Zeiten und CRLF", () => {
    const ics = buildIcs([{ uid: "a@x", start: new Date("2027-05-10T06:00:00Z"), end: new Date("2027-05-10T14:30:00Z"), summary: "Frühdienst", location: "Wien, Filiale" }], now);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20270510T060000Z");
    expect(ics).toContain("DTEND:20270510T143000Z");
    expect(ics).toContain("DTSTAMP:20270501T100000Z");
    expect(ics).toContain("LOCATION:Wien\\, Filiale"); // Komma maskiert
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });
  it("maskiert Sonderzeichen und verhindert eingeschleuste Zeilen", () => {
    const ics = buildIcs([{ uid: "b", start: now, end: now, summary: "A;B\nEND:VEVENT\r\nBEGIN:VEVENT" }], now);
    const lines = ics.split("\r\n");
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(1); // kein eingeschleuster Eintrag als eigene Zeile
    expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(1);
    expect(lines.find((l) => l.startsWith("SUMMARY:"))).toContain("A\\;B\\n");
  });
  it("faltet lange Zeilen, ohne Mehrbyte-Zeichen zu zerreißen", () => {
    const long = "Ä".repeat(100);
    const folded = fold(`SUMMARY:${long}`).split("\r\n");
    expect(folded.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(folded.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(folded.map((l, i) => (i ? l.slice(1) : l)).join("")).toBe(`SUMMARY:${long}`);
  });
  it("leerer Plan ergibt einen leeren, gültigen Kalender", () => {
    expect(buildIcs([], now)).not.toContain("BEGIN:VEVENT");
  });
});
