import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { allocateTax } from "./tax";

const t = (lines: { net: string; rate: string; group?: string }[]) => allocateTax(lines.map((l) => ({ ...l, group: l.group ?? l.rate })));
const s = (d: Decimal) => d.toString();

describe("Steuerberechnung", () => {
  it("einfacher Fall: 20 % auf 100,00", () => {
    const r = t([{ net: "100", rate: "20" }]);
    expect([s(r.netTotal), s(r.taxTotal), s(r.grossTotal)]).toEqual(["100", "20", "120"]);
  });
  it("Steuer wird je Steuersatz auf die Summe gerundet, nicht je Zeile", () => {
    // 3 × 0,10 € zu 20 %: je Zeile 0,02 (Summe 0,06), auf die Summe 0,30 → 0,06; hier gleich
    const r = t([{ net: "0.10", rate: "20" }, { net: "0.10", rate: "20" }, { net: "0.10", rate: "20" }]);
    expect(s(r.taxTotal)).toBe("0.06");
    // 3 × 0,07 € zu 20 %: je Zeile gerundet 0,01 (0,03), auf die Summe 0,21 → 0,04
    const q = t([{ net: "0.07", rate: "20" }, { net: "0.07", rate: "20" }, { net: "0.07", rate: "20" }]);
    expect(s(q.taxTotal)).toBe("0.04");
    expect(q.tax.reduce((a, b) => a.plus(b), new Decimal(0)).toString()).toBe("0.04"); // Verteilung geht exakt auf
  });
  it("Zeilensteuer summiert sich immer exakt zur Gruppensteuer (größte Reste)", () => {
    const r = t([{ net: "33.33", rate: "19" }, { net: "33.33", rate: "19" }, { net: "33.34", rate: "19" }]);
    expect(s(r.taxTotal)).toBe("19"); // 100,00 × 19 % = 19,00
    expect(r.tax.map(s).every((x) => /^\d+(\.\d{1,2})?$/.test(x))).toBe(true);
  });
  it("mehrere Steuersätze: je Gruppe gerundet, Brutto = Netto + Steuer", () => {
    const r = t([{ net: "10.01", rate: "20" }, { net: "5.55", rate: "10" }, { net: "7.77", rate: "10" }, { net: "100", rate: "0" }]);
    expect(s(r.taxTotal)).toBe("3.33"); // 20 %: 2,002 → 2,00; 10 %: 13,32 × 10 % = 1,332 → 1,33; dazu 0 %
    expect(s(r.netTotal.plus(r.taxTotal))).toBe(s(r.grossTotal));
  });
  it("kaufmännische Rundung bei x,5", () => {
    expect(s(t([{ net: "0.25", rate: "10" }]).taxTotal)).toBe("0.03"); // 0,025 → 0,03
    expect(s(t([{ net: "0.15", rate: "10" }]).taxTotal)).toBe("0.02"); // 0,015 → 0,02
  });
  it("Steuersatz 0 und leere Eingabe", () => {
    expect(s(t([{ net: "50", rate: "0" }]).taxTotal)).toBe("0");
    expect(s(allocateTax([]).grossTotal)).toBe("0");
  });
  it("Eigenschaft: für zufällige Beträge gilt Summe(Zeilensteuer) = Gruppensteuer und Brutto = Netto + Steuer", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 200; run++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({ net: (Math.floor(rnd() * 100000) / 100).toFixed(2), rate: ["0", "10", "13", "20"][Math.floor(rnd() * 4)]!, group: "" }));
      lines.forEach((l) => (l.group = l.rate));
      const r = allocateTax(lines);
      for (const rate of ["0", "10", "13", "20"]) {
        const idx = lines.map((l, i) => (l.rate === rate ? i : -1)).filter((i) => i >= 0);
        if (idx.length === 0) continue;
        const groupNet = idx.reduce((a, i) => a.plus(lines[i]!.net), new Decimal(0));
        const expected = groupNet.times(rate).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
        const actual = idx.reduce((a, i) => a.plus(r.tax[i]!), new Decimal(0));
        expect(actual.toString()).toBe(expected.toString());
      }
      expect(r.grossTotal.equals(r.netTotal.plus(r.taxTotal))).toBe(true);
    }
  });
});
