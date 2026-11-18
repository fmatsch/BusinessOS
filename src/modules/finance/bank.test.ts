import { describe, expect, it } from "vitest";
import { BankParseError, dedupeKeys, parseAmount, parseBankFile, parseCamt, parseCsv, parseDate, parseXml, suggestMatch, type Candidate } from "./bank";

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Ntry><Amt Ccy="EUR">1446.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><BookgDt><Dt>2027-03-10</Dt></BookgDt>
 <NtryDtls><TxDtls><Refs><EndToEndId>E2E-1</EndToEndId></Refs>
  <RltdPties><Dbtr><Nm>Kunde &amp; Söhne GmbH</Nm></Dbtr><DbtrAcct><Id><IBAN>AT61 1904 3002 3457 3201</IBAN></Id></DbtrAcct></RltdPties>
  <RmtInf><Ustrd>Zahlung Rechnung AR-2027-0001</Ustrd><Ustrd>Danke</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="EUR">250.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><BookgDt><Dt>2027-03-11</Dt></BookgDt>
 <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>Lieferant Müller</Nm></Cdtr></RltdPties><Refs><EndToEndId>NOTPROVIDED</EndToEndId></Refs><RmtInf><Ustrd>RE 2027/17</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
<Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><RvslInd>true</RvslInd><BookgDt><DtTm>2027-03-12T10:00:00</DtTm></BookgDt><AddtlNtryInf>Storno Lastschrift</AddtlNtryInf></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

describe("Kontoauszug: CAMT.053", () => {
  it("liest Eingang, Ausgang und Storno mit Vorzeichen, Gegenseite, IBAN und Verwendungszweck", () => {
    const l = parseCamt(CAMT);
    expect(l).toHaveLength(3);
    expect(l[0]).toEqual({ bookingDate: "2027-03-10", amount: "1446.00", currency: "EUR", counterpartyName: "Kunde & Söhne GmbH", counterpartyIban: "AT611904300234573201", reference: "Zahlung Rechnung AR-2027-0001 Danke", endToEndId: "E2E-1" });
    expect(l[1]).toMatchObject({ amount: "-250.50", counterpartyName: "Lieferant Müller", reference: "RE 2027/17", endToEndId: null });
    expect(l[2]).toMatchObject({ amount: "-10.00", reference: "Storno Lastschrift", bookingDate: "2027-03-12" }); // stornierter Eingang
  });
  it("lehnt DOCTYPE/Entitäten, kaputtes XML und fremde Dokumente ab", () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>')).toThrow(BankParseError);
    expect(() => parseXml("<a><b></a>")).toThrow(BankParseError);
    expect(() => parseCamt("<root/>")).toThrow(/Document/);
    expect(() => parseCamt('<Document><Ntry><Amt Ccy="EUR">x</Amt></Ntry></Document>')).toThrow(/Betrag/);
    expect(() => parseCamt("<Document><Stmt/></Document>")).toThrow(/keine Buchungen/);
    expect(() => parseXml("<a>".repeat(60))).toThrow(/tief/);
  });
});

describe("Kontoauszug: CSV", () => {
  it("erkennt Trennzeichen und Spalten, deutsche Beträge und Daten", () => {
    const csv = 'Buchungsdatum;Valuta;Betrag;Währung;Auftraggeber/Empfänger;IBAN;Verwendungszweck\r\n10.03.2027;10.03.2027;"1.446,00";EUR;Kunde GmbH;AT61 1904 3002 3457 3201;"Rechnung AR-2027-0001; danke"\r\n11.03.2027;11.03.2027;-250,50;EUR;Lieferant;;RE 17\r\n';
    const l = parseCsv(csv);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({ bookingDate: "2027-03-10", amount: "1446.00", counterpartyName: "Kunde GmbH", counterpartyIban: "AT611904300234573201", reference: "Rechnung AR-2027-0001; danke" });
    expect(l[1]).toMatchObject({ amount: "-250.50", counterpartyIban: null });
    expect(parseCsv("Date,Amount,Reference\n2027-03-10,\"1,234.56\",Test").map((x) => x.amount)).toEqual(["1234.56"]);
  });
  it("meldet fehlende Spalten und fehlerhafte Zeilen mit Zeilennummer", () => {
    expect(() => parseCsv("A;B\n1;2")).toThrow(/Datum und Betrag/);
    expect(() => parseCsv("Datum;Betrag\n10.03.2027;abc")).toThrow(/Zeile 2.*Betrag/);
    expect(() => parseCsv("Datum;Betrag\n31-12-2027;5")).toThrow(/Zeile 2.*Datum/);
    expect(() => parseCsv("Datum;Betrag")).toThrow(/keine Buchungen/);
  });
  it("Beträge in allen üblichen Schreibweisen", () => {
    expect(["1.234,56", "1234,56", "1234.56", "1,234.56", "-12,30", "12,30-", "(5,00)", "+7", " 3 EUR "].map(parseAmount)).toEqual(["1234.56", "1234.56", "1234.56", "1234.56", "-12.30", "-12.30", "-5.00", "7.00", "3.00"]);
    expect(parseDate("2027-03-10T12:00:00")).toBe("2027-03-10");
    expect(parseDate("1.2.2027")).toBe("2027-02-01");
  });
  it("Dateityp wird am Inhalt erkannt; zu große Dateien werden abgelehnt", () => {
    expect(parseBankFile("auszug.txt", CAMT).format).toBe("CAMT");
    expect(parseBankFile("a.csv", "Datum;Betrag\n10.03.2027;5").format).toBe("CSV");
    expect(() => parseBankFile("a.xml", "kein xml")).toThrow(/CAMT/);
    expect(() => parseBankFile("a.csv", "x".repeat(2 * 1024 * 1024 + 1))).toThrow(/zu groß/);
  });
});

describe("Kontoauszug: Dubletten und Zuordnung", () => {
  it("gleiche Zeilen in einer Datei bleiben erhalten, dieselbe Zeile in einer zweiten Datei hat denselben Schlüssel", () => {
    const l = { bookingDate: "2027-03-10", amount: "5.00", currency: "EUR", counterpartyName: null, counterpartyIban: null, reference: "x", endToEndId: null };
    const a = dedupeKeys([l, l, { ...l, amount: "6.00" }]);
    expect(new Set(a).size).toBe(3);
    expect(dedupeKeys([l, l])[0]).toBe(a[0]);
    expect(dedupeKeys([l])[0]).toBe(a[0]);
  });
  const cands: Candidate[] = [
    { kind: "CUSTOMER_INVOICE", id: "c1", numbers: ["AR-2027-0001"], amount: "1446.00", party: "Kunde & Söhne GmbH" },
    { kind: "CUSTOMER_INVOICE", id: "c2", numbers: ["AR-2027-0002"], amount: "1446.00", party: "Anderer Kunde" },
    { kind: "CUSTOMER_INVOICE", id: "c3", numbers: ["AR-2027-0003"], amount: "99.00", party: "Müller Handels AG" },
    { kind: "SUPPLIER_INVOICE", id: "s1", numbers: ["RE 2027/17", "ER-2027-0005"], amount: "250.50", party: "Lieferant Müller" },
  ];
  it("EXACT bei Belegnummer und Betrag, auch bei anderer Schreibweise", () => {
    expect(suggestMatch({ amount: "1446.00", reference: "Zahlung ar 2027 0001", counterpartyName: null }, cands)).toMatchObject({ strength: "EXACT", candidate: { id: "c1" } });
    expect(suggestMatch({ amount: "-250.50", reference: "RE2027/17", counterpartyName: null }, cands)).toMatchObject({ strength: "EXACT", candidate: { id: "s1" } });
  });
  it("kein Vorschlag bei falschem Betrag, mehrdeutigen Kandidaten oder falscher Richtung", () => {
    expect(suggestMatch({ amount: "1400.00", reference: "AR-2027-0001", counterpartyName: null }, cands)).toBeNull();
    expect(suggestMatch({ amount: "1446.00", reference: "Überweisung", counterpartyName: "Max" }, cands)).toBeNull(); // zwei gleiche Beträge, keine Nummer
    expect(suggestMatch({ amount: "-1446.00", reference: "AR-2027-0001", counterpartyName: null }, cands)).toBeNull(); // Ausgang ≠ Kundenrechnung
    expect(suggestMatch({ amount: "0.00", reference: "x", counterpartyName: null }, cands)).toBeNull();
  });
  it("POSSIBLE nur bei eindeutigem Betrag und passendem Namen", () => {
    expect(suggestMatch({ amount: "99.00", reference: "Sammelzahlung", counterpartyName: "MÜLLER HANDELS" }, cands)).toMatchObject({ strength: "POSSIBLE", candidate: { id: "c3" } });
    expect(suggestMatch({ amount: "99.00", reference: "Sammelzahlung", counterpartyName: "Schmidt" }, cands)).toBeNull();
  });
});
