import { describe, expect, it } from "vitest";
import { absenceDaySet, categoryMinutes, dailyTargetMinutes, daysOfMonth, monthBounds, monthTarget, scaleToNet } from "./rules";

const TZ = "Europe/Vienna";
const at = (iso: string) => new Date(iso);

describe("Monatsgrenzen", () => {
  it("Ortszeit-Monat als UTC-Zeitraum (Winter/Sommer, Jahreswechsel)", () => {
    const jan = monthBounds(2027, 1, TZ);
    expect(jan.from.toISOString()).toBe("2026-12-31T23:00:00.000Z");
    expect(jan.to.toISOString()).toBe("2027-01-31T23:00:00.000Z");
    expect(jan.lastDay).toBe("2027-01-31");
    const jun = monthBounds(2027, 6, TZ);
    expect(jun.from.toISOString()).toBe("2027-05-31T22:00:00.000Z");
    const dec = monthBounds(2027, 12, TZ);
    expect(dec.nextFirstDay).toBe("2028-01-01");
  });
  it("Monatslänge inkl. Schaltjahr", () => {
    expect(daysOfMonth(2028, 2)).toHaveLength(29);
    expect(daysOfMonth(2027, 2)).toHaveLength(28);
    expect(daysOfMonth(2027, 12)).toHaveLength(31);
  });
  it("Monat mit Sommerzeit-Umstellung hat einen 23-Stunden-Tag (März 2027 hat 743 statt 744 Stunden)", () => {
    const b = monthBounds(2027, 3, TZ);
    expect((b.to.getTime() - b.from.getTime()) / 3_600_000).toBe(743);
  });
});

describe("Zuschlagskategorien", () => {
  it("normale Tagschicht: keine Zuschläge", () => {
    expect(categoryMinutes(at("2027-05-11T06:00:00Z"), at("2027-05-11T14:00:00Z"), TZ)).toEqual({ gross: 480, night: 0, sunday: 0, holiday: 0 });
  });
  it("Nachtstunden 22–06 Ortszeit (Schicht 20:00–04:00 Ortszeit = 6 Nachtstunden)", () => {
    const c = categoryMinutes(at("2027-05-11T18:00:00Z"), at("2027-05-12T02:00:00Z"), TZ);
    expect(c.gross).toBe(480);
    expect(c.night).toBe(6 * 60);
  });
  it("Sonntag und Feiertag (Nationalfeiertag 26.10.2027 ist ein Dienstag)", () => {
    const sunday = categoryMinutes(at("2027-05-09T07:00:00Z"), at("2027-05-09T11:00:00Z"), TZ); // So 9.5.2027 09–13 Uhr
    expect(sunday).toMatchObject({ sunday: 240, holiday: 0, night: 0 });
    const holiday = categoryMinutes(at("2027-10-26T07:00:00Z"), at("2027-10-26T11:00:00Z"), TZ);
    expect(holiday).toMatchObject({ holiday: 240, sunday: 0 });
  });
  it("Schicht über Mitternacht von Samstag auf Sonntag: nur die Sonntagsminuten zählen", () => {
    const c = categoryMinutes(at("2027-05-08T20:00:00Z"), at("2027-05-09T02:00:00Z"), TZ); // Sa 22:00 – So 04:00 Ortszeit
    expect(c.gross).toBe(360);
    expect(c.sunday).toBe(240); // 00:00–04:00
    expect(c.night).toBe(360);
  });
  it("Zeitumstellung: Nachtschicht 22:00–06:00 in der Sommerzeit-Nacht hat 420 Minuten, alle in der Nacht", () => {
    const c = categoryMinutes(at("2027-03-27T21:00:00Z"), at("2027-03-28T04:00:00Z"), TZ);
    expect(c.gross).toBe(420);
    expect(c.night).toBe(420);
  });
  it("Pausenabzug anteilig", () => {
    const c = categoryMinutes(at("2027-05-11T18:00:00Z"), at("2027-05-12T02:00:00Z"), TZ);
    const net = scaleToNet(c, 450); // 30 min Pause
    expect(net.gross).toBe(450);
    expect(net.night).toBe(Math.round(360 * (450 / 480)));
  });
});

describe("Sollzeit", () => {
  it("Tagessoll = Wochenstunden / 5", () => {
    expect(dailyTargetMinutes("38.5")).toBe(462);
    expect(dailyTargetMinutes("20")).toBe(240);
    expect(dailyTargetMinutes("40")).toBe(480);
  });
  it("Mai 2027 bei 40 h: 21 Arbeitstage abzüglich Feiertage (1.5. Samstag, Himmelfahrt 6.5., Pfingstmontag 17.5., Fronleichnam 27.5.)", () => {
    const t = monthTarget(2027, 5, [{ from: "2020-01-01", to: null, weeklyHours: "40" }], new Set());
    // Mai 2027: 21 Mo–Fr-Tage, davon Feiertage 6.5., 17.5., 27.5. → 18 Arbeitstage
    expect(t.coveredDays).toBe(18);
    expect(t.targetMinutes).toBe(18 * 480);
  });
  it("Abwesenheitstage zählen als erfüllt (Soll 0)", () => {
    const abs = absenceDaySet([{ from: "2027-05-10", to: "2027-05-14" }], 2027, 5);
    const t = monthTarget(2027, 5, [{ from: "2020-01-01", to: null, weeklyHours: "40" }], abs);
    expect(t.targetMinutes).toBe(13 * 480); // 18 − 5
    expect(absenceDaySet([{ from: "2027-04-28", to: "2027-05-02" }], 2027, 5).size).toBe(2); // nur Tage im Monat
  });
  it("Beschäftigungswechsel im Monat: nur Tage mit gültigem Verhältnis, je mit eigenen Wochenstunden", () => {
    const t = monthTarget(2027, 5, [
      { from: "2027-01-01", to: "2027-05-14", weeklyHours: "40" },
      { from: "2027-05-15", to: null, weeklyHours: "20" },
    ], new Set());
    const before = [...t.perDay].filter(([d]) => d <= "2027-05-14").reduce((s, [, m]) => s + m, 0);
    const after = [...t.perDay].filter(([d]) => d >= "2027-05-15").reduce((s, [, m]) => s + m, 0);
    expect(before % 480).toBe(0);
    expect(after % 240).toBe(0);
    expect(before + after).toBe(t.targetMinutes);
  });
  it("ohne Beschäftigungsdaten kein Soll", () => {
    expect(monthTarget(2027, 5, [], new Set())).toMatchObject({ targetMinutes: 0, coveredDays: 0 });
  });
});
