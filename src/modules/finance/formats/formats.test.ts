import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { Decimal } from "@/lib/money";
import { encodeCp1252 } from "./encoding";
import { buildBmd, bmdBelegnr, bmdText, BMD_COLUMNS } from "./bmd";
import { buildDatev, DATEV_COLUMNS, datevBelegfeld, datevHeader } from "./datev";
import { buildPackage, packageFileName } from "./package";
import type { ExportLine, ExportVoucher } from "./types";

const D = (s: string) => new Decimal(s);
const line = (account: string, net: string, rate: string, extra: Partial<ExportLine> = {}): ExportLine => {
  const tax = D(net).times(rate).dividedBy(100).toDecimalPlaces(2);
  return { account, rate: D(rate), bmdCode: rate === "0" ? null : "2", datevKey: rate === "0" ? null : "9", net: D(net), tax, gross: D(net).plus(tax), costCenter: null, ...extra };
};
const voucher = (extra: Partial<ExportVoucher> = {}): ExportVoucher => ({
  type: "SUPPLIER", kind: "INVOICE", date: "2027-03-15", dueDate: "2027-04-14", documentNumber: "RE-2027/15", voucherNumber: "ER-2027-0001",
  personAccount: "33001", partnerName: "Müller & Söhne GmbH", uid: "ATU12345678", paymentTermsDays: 30, lines: [line("7000", "100.00", "20")], fileName: null, ...extra,
});

describe("Windows-1252", () => {
  it("Umlaute, Euro und typografische Zeichen; Unbekanntes wird zu ?", () => {
    expect([...encodeCp1252("äöüß€–")]).toEqual([0xe4, 0xf6, 0xfc, 0xdf, 0x80, 0x96]);
    expect([...encodeCp1252("日")]).toEqual([0x3f]);
  });
});

describe("DATEV Buchungsstapel", () => {
  const profile = { advisorNumber: "12345", clientNumber: "67890", accountLength: 4, fiscalYearStart: "2027-01-01", dictationCode: "BO", currency: "EUR" };
  const meta = { version: 3, now: new Date("2027-04-01T10:20:30.123Z"), label: "Belege 2027-03" };

  it("125 Spalten in der Reihenfolge der Formatbeschreibung", () => {
    expect(DATEV_COLUMNS).toHaveLength(125);
    expect(DATEV_COLUMNS.slice(0, 10)).toEqual(["Umsatz (ohne Soll/Haben-Kz)", "Soll/Haben-Kennzeichen", "WKZ Umsatz", "Kurs", "Basis-Umsatz", "WKZ Basis-Umsatz", "Konto", "Gegenkonto (ohne BU-Schlüssel)", "BU-Schlüssel", "Belegdatum"]);
    expect(DATEV_COLUMNS[19]).toBe("Beleglink");
    expect(DATEV_COLUMNS[36]).toBe("Kost 1 - Kostenstelle");
    expect(DATEV_COLUMNS[113]).toBe("Festschreibung");
    expect(DATEV_COLUMNS[116]).toBe("Fälligkeit");
  });
  it("Kopfzeile hat 31 Felder und die erwarteten Werte", () => {
    const h = datevHeader(profile, meta.now, "2027-03-15", "2027-03-31", "Belege");
    const f = h.split(";");
    expect(f).toHaveLength(31);
    expect(f.slice(0, 6)).toEqual(['"EXTF"', "700", "21", '"Buchungsstapel"', "13", "20270401102030123"]);
    expect(f.slice(10, 16)).toEqual(["12345", "67890", "20270101", "4", "20270315", "20270331"]);
    expect(f[18]).toBe("1"); // Buchungstyp Finanzbuchführung
    expect(f[21]).toBe('"EUR"');
  });
  it("Eingangsrechnung: Aufwand im Soll, Kreditor als Gegenkonto, Brutto, BU-Schlüssel, Belegdatum TTMM", () => {
    const r = buildDatev([voucher()], profile, meta);
    const lines = r.content.split("\r\n");
    expect(lines).toHaveLength(4); // Kopf, Spalten, 1 Buchung, leeres Ende nach CRLF
    const row = lines[2]!.split(";");
    expect(row).toHaveLength(125);
    expect(row.slice(0, 9)).toEqual(["120,00", '"S"', '"EUR"', "", "", "", "7000", "33001", '"9"']);
    expect(row[9]).toBe("1503");
    expect(row[10]).toBe('"RE-2027/15"');
    expect(row[13]).toBe('"Müller & Söhne GmbH RE-2027/15"');
    expect(row[116]).toBe("14042027"); // Fälligkeit TTMMJJJJ
    expect(r.fileName).toBe("EXTF_Buchungsstapel_0003.csv");
    expect(r.lineCount).toBe(1);
    expect(r.content.endsWith("\r\n")).toBe(true);
  });
  it("Ausgangsrechnung: Debitor im Soll; Gutschrift vertauscht Soll und Haben bei positivem Betrag", () => {
    const ar = voucher({ type: "CUSTOMER", voucherNumber: "AR-2027-0001", documentNumber: "AR-2027-0001", personAccount: "20001", lines: [line("4000", "50", "20")] });
    const row = buildDatev([ar], profile, meta).content.split("\r\n")[2]!.split(";");
    expect([row[0], row[6], row[7]]).toEqual(["60,00", "20001", "4000"]);
    const credit = buildDatev([{ ...ar, kind: "CREDIT" }], profile, meta).content.split("\r\n")[2]!.split(";");
    expect([credit[0], credit[6], credit[7]]).toEqual(["60,00", "4000", "20001"]);
  });
  it("Kostenstelle, Belegdatei, steuerfreie Zeile ohne BU-Schlüssel", () => {
    const v = voucher({ fileName: "ER-2027-0001.pdf", lines: [line("7000", "10", "0", { costCenter: "K100" })] });
    const row = buildDatev([v], profile, meta).content.split("\r\n")[2]!.split(";");
    expect(row[8]).toBe(""); // kein BU-Schlüssel
    expect(row[36]).toBe('"K100"');
    expect(row[20]).toBe('"Belegdatei"');
    expect(row[21]).toBe('"ER-2027-0001.pdf"');
  });
  it("Belegfeld: nur zulässige Zeichen, höchstens 36 Stellen; Anführungszeichen im Text werden verdoppelt", () => {
    expect(datevBelegfeld("RE 2027/1#ä")).toBe("RE_2027/1__");
    expect(datevBelegfeld("x".repeat(50))).toHaveLength(36);
    const row = buildDatev([voucher({ partnerName: 'Firma "X"' })], profile, meta).content.split("\r\n")[2]!.split(";");
    expect(row[13]).toBe('"Firma ""X"" RE-2027/15"');
  });
  it("Bytes sind Windows-1252 (Umlaut = 1 Byte)", () => {
    const r = buildDatev([voucher()], profile, meta);
    expect(r.bytes.includes(0xfc)).toBe(true); // ü in „Müller"
  });
});

describe("BMD BuErf variabel", () => {
  const profile = { symbolIn: "ER", symbolOut: "AR" };
  it("Spalten und Kopfzeile", () => {
    expect(BMD_COLUMNS).toHaveLength(19);
    expect(buildBmd([], profile, { version: 1 }).content.split("\r\n")[0]).toBe("satzart;konto;gkonto;belegnr;belegdatum;buchdat;betrag;steuer;steuercode;prozent;text;buchcode;buchsymbol;extbelegnr;zziel;uidnr;kost;gegenbuchkz;document");
  });
  it("Eingangsrechnung: Kreditor führt (Brutto), Buchcode 2, Steuercode und Prozent, OP-Nummer, Datum TT.MM.JJJJ", () => {
    const r = buildBmd([voucher()], profile, { version: 1 });
    const row = r.content.split("\r\n")[1]!.split(";");
    expect(row).toEqual(["0", "33001", "7000", "20270001", "15.03.2027", "15.03.2027", "120,00", "", "2", "20", "Müller & Söhne GmbH RE-2027/15", "2", "ER", "RE-2027/15", "30", "ATU12345678", "", "E", ""]);
    expect(r.fileName).toBe("buerf_0001.csv");
  });
  it("Ausgangsrechnung: Debitor im Soll → Buchcode 1, Symbol AR; Gutschrift → Buchcode 2", () => {
    const ar = voucher({ type: "CUSTOMER", voucherNumber: "AR-2027-0007", documentNumber: "AR-2027-0007", personAccount: "20001" });
    expect(buildBmd([ar], profile, { version: 1 }).content.split("\r\n")[1]!.split(";").slice(11, 13)).toEqual(["1", "AR"]);
    expect(buildBmd([{ ...ar, kind: "CREDIT" }], profile, { version: 1 }).content.split("\r\n")[1]!.split(";")[11]).toBe("2");
  });
  it("mehrere Steuersätze = Splittbuchung (gegenbuchkz O) mit gleicher Belegnummer", () => {
    const v = voucher({ lines: [line("7000", "100", "20"), line("7100", "50", "10")] });
    const rows = buildBmd([v], profile, { version: 1 }).content.split("\r\n").slice(1, 3).map((l) => l.split(";"));
    expect(rows.map((r) => r[17])).toEqual(["O", "O"]);
    expect(new Set(rows.map((r) => r[3])).size).toBe(1);
    expect(rows.map((r) => r[6])).toEqual(["120,00", "55,00"]);
  });
  it("Text ohne Semikolon, ≤ 40 Zeichen; Belegnummer numerisch ≤ 9 Stellen; nicht numerische Kostenstelle bleibt leer", () => {
    expect(bmdText("a;b\nc")).toBe("a b c");
    expect(bmdText("x".repeat(60))).toHaveLength(40);
    expect(bmdBelegnr("ER-2027-0001")).toBe("20270001");
    expect(bmdBelegnr("ER-12345678901")).toHaveLength(9);
    const row = buildBmd([voucher({ lines: [line("7000", "1", "0", { costCenter: "K100" })] })], profile, { version: 1 }).content.split("\r\n")[1]!.split(";");
    expect(row[16]).toBe("");
    const num = buildBmd([voucher({ lines: [line("7000", "1", "0", { costCenter: "100" })] })], profile, { version: 1 }).content.split("\r\n")[1]!.split(";");
    expect(num[16]).toBe("100");
  });
  it("Belegdatei wird in der Spalte document referenziert", () => {
    expect(buildBmd([voucher({ fileName: "ER-2027-0001.pdf" })], profile, { version: 1 }).content.split("\r\n")[1]!.split(";")[18]).toBe("ER-2027-0001.pdf");
  });
});

describe("Belegpaket (ZIP)", () => {
  it("enthält die Dateien unverändert, ist reproduzierbar und lehnt doppelte Namen ab", () => {
    const files = [{ name: "b.pdf", data: new Uint8Array([2, 2]) }, { name: "a.pdf", data: new Uint8Array([1, 1, 1]) }];
    const zip = buildPackage(files);
    const out = unzipSync(zip);
    expect(Object.keys(out)).toEqual(["a.pdf", "b.pdf"]);
    expect([...out["a.pdf"]!]).toEqual([1, 1, 1]);
    expect(Buffer.from(buildPackage([...files].reverse())).equals(Buffer.from(zip))).toBe(true);
    expect(() => buildPackage([files[0]!, files[0]!])).toThrow(/Doppelter/);
  });
  it("Dateinamen ohne Pfadanteile", () => {
    expect(packageFileName("ER-2027-0001", "../../evil name.PDF")).toBe("ER-2027-0001.pdf");
    expect(packageFileName("AR 2027/1", "scan")).toBe("AR_2027_1.bin");
  });
});
