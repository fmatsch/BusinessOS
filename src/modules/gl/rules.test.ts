import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { balanceSheet, fiscalYearStart, incomeStatement, kindOf, paymentPosting, postingProblem, purchasePosting, reversalLines, salesPosting, sumOf, validateEntry, type AccountSums, type DocLine, type TaxInfo } from "./rules";

const d = (v: string) => new Decimal(v);
const tax = new Map<string, TaxInfo>([["u20", { rate: d("20"), vatAccountId: "ust", key: "U20" }], ["u10", { rate: d("10"), vatAccountId: "ust10", key: "U10" }], ["u0", { rate: d("0"), vatAccountId: null, key: "U0" }]]);
const balanced = (lines: { debit: Decimal; credit: Decimal }[]) => sumOf(lines.map((l) => l.debit)).eq(sumOf(lines.map((l) => l.credit)));

describe("Buchungssatz prüfen", () => {
  const l = (debit: string, credit: string) => ({ accountId: "a", debit: d(debit), credit: d(credit) });
  it("verlangt Ausgleich, genau eine Seite je Zeile und mindestens zwei Zeilen", () => {
    expect(validateEntry([l("100", "0"), l("0", "100")])).toBeNull();
    expect(validateEntry([l("100", "0")])).toMatch(/zwei Zeilen/);
    expect(validateEntry([l("100", "0"), l("0", "99.99")])).toMatch(/nicht ausgeglichen/);
    expect(validateEntry([l("100", "100"), l("0", "0")])).toMatch(/genau eine Seite/);
    expect(validateEntry([l("0", "0"), l("0", "0")])).toMatch(/genau eine Seite/);
    expect(validateEntry([l("-5", "0"), l("0", "-5")])).toMatch(/negativ/);
    expect(validateEntry([l("0.005", "0"), l("0", "0.005")])).toMatch(/Nachkommastellen/);
  });
});

describe("Buchungsregeln für Belege", () => {
  const lines: DocLine[] = [
    { accountId: "erloes", taxCodeId: "u20", net: d("100.01") },
    { accountId: "erloes", taxCodeId: "u20", net: d("200.02") },
    { accountId: "erloes10", taxCodeId: "u10", net: d("50") },
    { accountId: "erloes0", taxCodeId: "u0", net: d("10") },
  ];
  it("Ausgangsrechnung: Debitor an Erlöse und Umsatzsteuer; ausgeglichen; Steuer wie auf dem Beleg gerundet", () => {
    const p = salesPosting({ receivableAccountId: "deb", lines, tax, credit: false });
    expect(balanced(p)).toBe(true);
    const gross = p.find((x) => x.accountId === "deb")!;
    expect(gross.debit.toFixed(2)).toBe("425.04"); // 360,03 netto + 60,01 (20 %: 60,006 gerundet) + 5,00 (10 %)
    expect(p.find((x) => x.accountId === "ust")!.credit.toFixed(2)).toBe("60.01");
    expect(p.find((x) => x.accountId === "ust10")!.credit.toFixed(2)).toBe("5.00");
    expect(p.some((x) => x.accountId === "erloes0")).toBe(true);
    expect(p.filter((x) => x.accountId === "erloes").length).toBe(1); // gleiche Konto/Steuer-Kombination zusammengefasst
    expect(p.find((x) => x.accountId === "erloes")!.credit.toFixed(2)).toBe("300.03");
    expect(p.find((x) => x.accountId === "ust")).toMatchObject({ taxCodeId: "u20", taxRole: "TAX" });
    expect(p.find((x) => x.accountId === "erloes")).toMatchObject({ taxCodeId: "u20", taxRole: "BASE" });
  });
  it("Gutschrift kehrt die Seiten um; Storno ebenso", () => {
    const s = salesPosting({ receivableAccountId: "deb", lines, tax, credit: false });
    const c = salesPosting({ receivableAccountId: "deb", lines, tax, credit: true });
    expect(c.find((x) => x.accountId === "deb")!.credit.toFixed(2)).toBe("425.04");
    expect(balanced(c)).toBe(true);
    const r = reversalLines(s);
    expect(r.map((x) => [x.debit.toFixed(2), x.credit.toFixed(2)])).toEqual(c.map((x) => [x.debit.toFixed(2), x.credit.toFixed(2)]));
  });
  it("Eingangsrechnung: Aufwand und Vorsteuer an Kreditor", () => {
    const p = purchasePosting({ payableAccountId: "kred", lines, tax, credit: false });
    expect(balanced(p)).toBe(true);
    expect(p.find((x) => x.accountId === "kred")!.credit.toFixed(2)).toBe("425.04");
    expect(p.find((x) => x.accountId === "ust")!.debit.toFixed(2)).toBe("60.01"); // Vorsteuerkonto je Steuerkennzeichen
    expect(balanced(purchasePosting({ payableAccountId: "kred", lines, tax, credit: true }))).toBe(true);
  });
  it("Zahlungen: Bank an Debitor bzw. Kreditor an Bank", () => {
    const i = paymentPosting({ bankAccountId: "bank", partyAccountId: "deb", amount: d("120"), incoming: true });
    expect(i.map((x) => [x.accountId, x.debit.toString(), x.credit.toString()])).toEqual([["bank", "120", "0"], ["deb", "0", "120"]]);
    const o = paymentPosting({ bankAccountId: "bank", partyAccountId: "kred", amount: d("120"), incoming: false });
    expect(o.map((x) => [x.accountId, x.debit.toString(), x.credit.toString()])).toEqual([["kred", "120", "0"], ["bank", "0", "120"]]);
  });
  it("meldet fehlende Steuerkonten und unbekannte Steuerkennzeichen", () => {
    expect(postingProblem(lines, tax)).toBeNull();
    expect(postingProblem(lines, new Map([...tax, ["u20", { rate: d("20"), vatAccountId: null, key: "U20" }]]))).toMatch(/kein Steuerkonto/);
    expect(postingProblem([{ accountId: "x", taxCodeId: "nix", net: d("1") }], tax)).toMatch(/Steuerkennzeichen fehlt/);
    expect(postingProblem([{ accountId: "", taxCodeId: "u0", net: d("1") }], tax)).toMatch(/Konto/);
  });
});

describe("Auswertungen", () => {
  const rows: AccountSums[] = [
    { accountId: "bank", number: "2800", name: "Bank", kind: "ASSET", debit: d("1500"), credit: d("300") },
    { accountId: "deb", number: "2000", name: "Forderungen", kind: "ASSET", debit: d("600"), credit: d("0") },
    { accountId: "kred", number: "3300", name: "Verbindlichkeiten", kind: "LIABILITY", debit: d("0"), credit: d("400") },
    { accountId: "ek", number: "9000", name: "Stammkapital", kind: "EQUITY", debit: d("0"), credit: d("1000") },
    { accountId: "erloes", number: "4000", name: "Erlöse", kind: "INCOME", debit: d("0"), credit: d("900") },
    { accountId: "aufw", number: "7000", name: "Aufwand", kind: "EXPENSE", debit: d("300"), credit: d("0") },
  ];
  it("GuV: Ertrag minus Aufwand", () => {
    const g = incomeStatement(rows);
    expect(g.income.total.toString()).toBe("900");
    expect(g.expense.total.toString()).toBe("300");
    expect(g.result.toString()).toBe("600");
  });
  it("Bilanz: Aktiva = Passiva inklusive Ergebnis; Differenz wird sichtbar", () => {
    // Aktiva: 1200 + 600 = 1800 · Passiva: 400 + 1000 + Ergebnis 400 (Vortrag 0, laufend 400)
    const b = balanceSheet(rows.filter((r) => ["ASSET", "LIABILITY", "EQUITY"].includes(r.kind!)), d("0"), d("400"));
    expect(b.assets.total.toString()).toBe("1800");
    expect(b.passivaTotal.toString()).toBe("1800");
    expect(b.difference.toString()).toBe("0");
    expect(balanceSheet(rows.filter((r) => r.kind !== "INCOME" && r.kind !== "EXPENSE"), d("0"), d("399")).difference.toString()).toBe("1");
  });
  it("Einordnung der Konten und Geschäftsjahr", () => {
    expect(kindOf({ type: "CUSTOMER", kind: null })).toBe("ASSET");
    expect(kindOf({ type: "VENDOR", kind: null })).toBe("LIABILITY");
    expect(kindOf({ type: "GL", kind: "INCOME" })).toBe("INCOME");
    expect(kindOf({ type: "GL", kind: null })).toBeNull();
    expect(fiscalYearStart("2027-03-15")).toBe("2027-01-01");
    expect(fiscalYearStart("2027-03-15", 7)).toBe("2026-07-01");
    expect(fiscalYearStart("2027-07-01", 7)).toBe("2027-07-01");
  });
});
