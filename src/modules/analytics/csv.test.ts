import { describe, expect, it } from "vitest";
import { numberCell, textCell, toCsv } from "./csv";

describe("Bericht als CSV", () => {
  it("schützt Textzellen vor Formelinjektion und maskiert Trennzeichen", () => {
    expect(textCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    for (const f of ["+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(textCell(f).replace(/^"/, "").startsWith("'")).toBe(true);
    expect(textCell("Müller; Söhne")).toBe('"Müller; Söhne"');
    expect(textCell("normal")).toBe("normal");
  });
  it("Zahlen nur als Zahlen (Dezimalkomma); alles andere bleibt leer", () => {
    expect(numberCell("1234.5")).toBe("1234,5");
    expect(numberCell("-12")).toBe("-12");
    expect(numberCell("=1+1")).toBe("");
    expect(numberCell("1e5")).toBe("");
  });
  it("erzeugt Kopfzeile, BOM und CRLF", () => {
    const csv = toCsv([{ key: "a", label: "Name" }, { key: "b", label: "Betrag", numeric: true }], [{ a: "=evil", b: "10.50" }, { a: "ok", b: "x" }]);
    expect(csv.startsWith("﻿Name;Betrag\r\n")).toBe(true);
    expect(csv).toContain("'=evil;10,50\r\n");
    expect(csv.endsWith("ok;\r\n")).toBe(true);
  });
});
