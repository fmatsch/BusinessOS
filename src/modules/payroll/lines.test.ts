import { describe, expect, it } from "vitest";
import { buildCsv, csvField, encodeCsv, fileNameFor, formatQuantity, sha256, type CsvProfile } from "./csv";
import { desiredQuantities, diffQuantities, percentFor, unitOf, WAGE_TYPES, type WageType } from "./lines";

const zeroAbs = { VACATION: 0, SICK: 0, CARE: 0, SPECIAL: 0 };

describe("Sollmengen je Lohnart", () => {
  it("unter Soll: nur Normalarbeitszeit; über Soll: Normal bis Soll, Rest als Mehrzeit", () => {
    const base = { targetMinutes: 8000, night: 0, sunday: 0, holiday: 0 };
    expect(desiredQuantities({ ...base, workedMinutes: 7000 }, zeroAbs)).toMatchObject({ NORMAL: 7000, MEHRZEIT: 0 });
    expect(desiredQuantities({ ...base, workedMinutes: 8000 }, zeroAbs)).toMatchObject({ NORMAL: 8000, MEHRZEIT: 0 });
    expect(desiredQuantities({ ...base, workedMinutes: 8500 }, zeroAbs)).toMatchObject({ NORMAL: 8000, MEHRZEIT: 500 });
  });
  it("Normal + Mehrzeit = gearbeitete Zeit; Zuschlagsbasen sind Teilmengen und verändern die Arbeitszeit nicht", () => {
    const q = desiredQuantities({ workedMinutes: 9000, targetMinutes: 8000, night: 600, sunday: 480, holiday: 0 }, { ...zeroAbs, VACATION: 3, SICK: 2 });
    expect(q.NORMAL + q.MEHRZEIT).toBe(9000);
    expect([q.NIGHT, q.SUNDAY, q.HOLIDAY]).toEqual([600, 480, 0]);
    expect([q.VACATION, q.SICK, q.CARE, q.SPECIAL]).toEqual([3, 2, 0, 0]);
  });
  it("Einheiten: Abwesenheiten in Tagen, sonst Minuten", () => {
    expect(WAGE_TYPES.filter((w) => unitOf(w) === "DAYS")).toEqual(["VACATION", "SICK", "CARE", "SPECIAL"]);
  });
  it("Zuschlagsprozente aus den Regeln", () => {
    const rules = { NIGHT: 25, SUNDAY: 100, HOLIDAY: 100, OVERTIME: 50 };
    expect([percentFor("NIGHT", rules), percentFor("MEHRZEIT", rules), percentFor("NORMAL", rules), percentFor("VACATION", rules)]).toEqual([25, 50, null, null]);
  });
});

describe("Nachtrag (Differenzen)", () => {
  const d = (n: number) => ({ NORMAL: n, MEHRZEIT: 0, NIGHT: 0, SUNDAY: 0, HOLIDAY: 0, VACATION: 0, SICK: 0, CARE: 0, SPECIAL: 0 });
  it("ohne Änderung keine Zeilen", () => {
    expect(diffQuantities(d(100), { NORMAL: 100 })).toEqual([]);
  });
  it("Erhöhung, Verminderung und neue Lohnart", () => {
    expect(diffQuantities({ ...d(120), SICK: 2 }, { NORMAL: 100 })).toEqual([{ wageType: "NORMAL", quantity: 20 }, { wageType: "SICK", quantity: 2 }]);
    expect(diffQuantities(d(80), { NORMAL: 100 })).toEqual([{ wageType: "NORMAL", quantity: -20 }]);
  });
  it("Summe aus Erstexport und Nachträgen ergibt immer den aktuellen Sollwert", () => {
    const states = [d(100), d(130), d(90), d(90), d(0)];
    let cumulative: Partial<Record<WageType, number>> = {};
    for (const s of states) {
      for (const x of diffQuantities(s, cumulative)) cumulative = { ...cumulative, [x.wageType]: (cumulative[x.wageType] ?? 0) + x.quantity };
      expect(cumulative.NORMAL ?? 0).toBe(s.NORMAL);
    }
  });
});

describe("CSV", () => {
  const profile: CsvProfile = {
    delimiter: ";", decimalSeparator: ",", includeHeader: true, encoding: "utf8-bom", unit: "HOURS", includeSurcharge: true,
    codes: { NORMAL: "1000", MEHRZEIT: "2000", NIGHT: "3000", VACATION: "9000" },
  };
  it("Dezimalstunden mit Komma, kaufmännisch auf 2 Stellen; Tage ganzzahlig", () => {
    expect(formatQuantity(450, "NORMAL", "HOURS", ",").text).toBe("7,50");
    expect(formatQuantity(1, "NORMAL", "HOURS", ",").text).toBe("0,02"); // 1/60 = 0,0167
    expect(formatQuantity(31, "NORMAL", "HOURS", ".").text).toBe("0.52");
    expect(formatQuantity(-90, "NORMAL", "HOURS", ",").text).toBe("-1,50");
    expect(formatQuantity(450, "NORMAL", "MINUTES", ",").text).toBe("450");
    expect(formatQuantity(3, "VACATION", "HOURS", ",")).toEqual({ text: "3", unitLabel: "Tage" });
  });
  it("Zeilen, Kopf, Zuschlag, Lauf und Zeilenende CRLF", () => {
    const csv = buildCsv([
      { employeeNumber: "101", wageType: "NORMAL", quantity: 7200, percent: null },
      { employeeNumber: "101", wageType: "NIGHT", quantity: 450, percent: 25 },
      { employeeNumber: "102", wageType: "VACATION", quantity: 3, percent: null },
    ], profile, { year: 2027, month: 3, version: 1 });
    expect(csv.split("\r\n")).toEqual([
      "Personalnummer;Zeitraum;Lohnart;Bezeichnung;Menge;Einheit;Zuschlag %;Lauf",
      "101;2027-03;1000;Normalarbeitszeit;120,00;Std;;1",
      "101;2027-03;3000;Nachtarbeit (Zuschlagsbasis);7,50;Std;25;1",
      "102;2027-03;9000;Urlaub;3;Tage;;1",
      "",
    ]);
  });
  it("ohne Kopf und ohne Zuschlagsspalte; Dezimalkomma wird bei Komma als Trenner maskiert", () => {
    const csv = buildCsv([{ employeeNumber: "7", wageType: "NORMAL", quantity: 60, percent: null }], { ...profile, includeHeader: false, includeSurcharge: false, delimiter: "," }, { year: 2027, month: 12, version: 2 });
    expect(csv).toBe('7,2027-12,1000,Normalarbeitszeit,"1,00",Std,2\r\n');
  });
  it("Masken: Trennzeichen, Anführungszeichen, Formel-Injection", () => {
    expect(csvField("a;b", ";")).toBe('"a;b"');
    expect(csvField('say "hi"', ";")).toBe('"say ""hi"""');
    expect(csvField("=SUM(A1)", ";")).toBe("'=SUM(A1)");
    expect(csvField("-5", ";")).toBe("'-5");
    expect(csvField("normal", ";")).toBe("normal");
  });
  it("negative Nachtragsmengen werden als Zahl ausgegeben (nicht als Text mit Hochkomma)", () => {
    const csv = buildCsv([{ employeeNumber: "7", wageType: "NORMAL", quantity: -90, percent: null }], profile, { year: 2027, month: 3, version: 2 });
    expect(csv).toContain(";-1,50;");
  });
  it("Dateiname und Zeichensatz", () => {
    expect(fileNameFor(2027, 3, 1)).toBe("lohnexport-2027-03-erstexport.csv");
    expect(fileNameFor(2027, 3, 3)).toBe("lohnexport-2027-03-nachtrag2.csv");
    expect([...encodeCsv("ä", "utf8-bom")]).toEqual([0xef, 0xbb, 0xbf, 0xc3, 0xa4]);
    expect([...encodeCsv("ä", "utf8")]).toEqual([0xc3, 0xa4]);
    expect([...encodeCsv("ä", "latin1")]).toEqual([0xe4]);
    expect(sha256(Buffer.from("a"))).toHaveLength(64);
  });
});
