/**
 * Hauptbuch – reine Regeln ohne Datenbank: Prüfung von Buchungssätzen, Buchungsregeln für Belege und Zahlungen, Auswertungen.
 * Beträge immer als Decimal. Soll/Haben je Zeile: genau eine Seite größer 0.
 */
import { Decimal } from "@/lib/money";
import { allocateTax } from "@/modules/finance/queries";

export interface PostingLine {
  accountId: string;
  debit: Decimal;
  credit: Decimal;
  costCenterId?: string | null;
  taxCodeId?: string | null;
  /** BASE = Bemessungsgrundlage, TAX = Steuerbetrag */
  taxRole?: "BASE" | "TAX" | null;
  text?: string | null;
}

const D0 = new Decimal(0);
export const sumOf = (xs: Decimal[]) => xs.reduce((a, x) => a.plus(x), D0);

/** Prüft einen Buchungssatz: mindestens zwei Zeilen, je Zeile genau eine Seite > 0, höchstens 2 Nachkommastellen, Soll = Haben. */
export function validateEntry(lines: PostingLine[]): string | null {
  if (lines.length < 2) return "Ein Buchungssatz braucht mindestens zwei Zeilen";
  for (const l of lines) {
    if (l.debit.isNeg() || l.credit.isNeg()) return "Beträge dürfen nicht negativ sein";
    if ((l.debit.gt(0) ? 1 : 0) + (l.credit.gt(0) ? 1 : 0) !== 1) return "Jede Zeile hat genau eine Seite (Soll oder Haben) mit einem Betrag größer 0";
    if (l.debit.decimalPlaces() > 2 || l.credit.decimalPlaces() > 2) return "Höchstens 2 Nachkommastellen";
  }
  const diff = sumOf(lines.map((l) => l.debit)).minus(sumOf(lines.map((l) => l.credit)));
  if (!diff.isZero()) return `Soll und Haben sind nicht ausgeglichen (Differenz ${diff.toFixed(2)})`;
  return null;
}

const dr = (accountId: string, amount: Decimal, extra: Partial<PostingLine> = {}): PostingLine => ({ accountId, debit: amount, credit: D0, ...extra });
const cr = (accountId: string, amount: Decimal, extra: Partial<PostingLine> = {}): PostingLine => ({ accountId, debit: D0, credit: amount, ...extra });
const flip = (l: PostingLine): PostingLine => ({ ...l, debit: l.credit, credit: l.debit });

export interface DocLine { accountId: string; taxCodeId: string; net: Decimal; costCenterId?: string | null }
export interface TaxInfo { rate: Decimal; vatAccountId: string | null; key: string }

/** Steuer je Steuerkennzeichen (auf die Summe gerundet wie auf dem Beleg) und je Zeile verteilt. */
function priced(lines: DocLine[], tax: Map<string, TaxInfo>) {
  const res = allocateTax(lines.map((l) => ({ net: l.net, rate: tax.get(l.taxCodeId)?.rate ?? 0, group: l.taxCodeId })));
  const byCode = new Map<string, Decimal>();
  lines.forEach((l, i) => byCode.set(l.taxCodeId, (byCode.get(l.taxCodeId) ?? D0).plus(res.tax[i]!)));
  return { ...res, byCode };
}

/** Problem, das das Buchen verhindert (z. B. Steuerkonto fehlt), sonst null. */
export function postingProblem(lines: DocLine[], tax: Map<string, TaxInfo>): string | null {
  for (const l of lines) {
    const t = tax.get(l.taxCodeId);
    if (!t) return "Steuerkennzeichen fehlt";
    if (!l.accountId) return "Nicht jede Position hat ein Konto";
    if (t.rate.gt(0) && !t.vatAccountId) return `Für das Steuerkennzeichen ${t.key} ist kein Steuerkonto im Hauptbuch hinterlegt`;
  }
  return null;
}

/**
 * Ausgangsrechnung: Debitor an Erlöse und Umsatzsteuer. Gutschrift: umgekehrt.
 * Die Steuerzeilen tragen Steuerkennzeichen und Rolle TAX, die Erlöszeilen BASE (für die Umsatzsteuer-Voranmeldung).
 */
export function salesPosting(input: { receivableAccountId: string; lines: DocLine[]; tax: Map<string, TaxInfo>; credit: boolean; text?: string }): PostingLine[] {
  const p = priced(input.lines, input.tax);
  const out: PostingLine[] = [];
  const grossAccount = dr(input.receivableAccountId, p.grossTotal, { text: input.text });
  const revenue = new Map<string, PostingLine>();
  input.lines.forEach((l) => {
    const key = `${l.accountId}|${l.taxCodeId}|${l.costCenterId ?? ""}`;
    const prev = revenue.get(key);
    if (prev) prev.credit = prev.credit.plus(l.net);
    else revenue.set(key, cr(l.accountId, l.net, { costCenterId: l.costCenterId ?? null, taxCodeId: l.taxCodeId, taxRole: "BASE" }));
  });
  out.push(grossAccount, ...revenue.values());
  for (const [code, amount] of p.byCode) {
    const t = input.tax.get(code)!;
    if (amount.gt(0)) out.push(cr(t.vatAccountId!, amount, { taxCodeId: code, taxRole: "TAX" }));
  }
  const lines = out.filter((l) => l.debit.gt(0) || l.credit.gt(0));
  return input.credit ? lines.map(flip) : lines;
}

/** Eingangsrechnung: Aufwand und Vorsteuer an Kreditor. Gutschrift: umgekehrt. */
export function purchasePosting(input: { payableAccountId: string; lines: DocLine[]; tax: Map<string, TaxInfo>; credit: boolean; text?: string }): PostingLine[] {
  const p = priced(input.lines, input.tax);
  const expense = new Map<string, PostingLine>();
  input.lines.forEach((l) => {
    const key = `${l.accountId}|${l.taxCodeId}|${l.costCenterId ?? ""}`;
    const prev = expense.get(key);
    if (prev) prev.debit = prev.debit.plus(l.net);
    else expense.set(key, dr(l.accountId, l.net, { costCenterId: l.costCenterId ?? null, taxCodeId: l.taxCodeId, taxRole: "BASE" }));
  });
  const out: PostingLine[] = [...expense.values()];
  for (const [code, amount] of p.byCode) {
    const t = input.tax.get(code)!;
    if (amount.gt(0)) out.push(dr(t.vatAccountId!, amount, { taxCodeId: code, taxRole: "TAX" }));
  }
  out.push(cr(input.payableAccountId, p.grossTotal, { text: input.text }));
  const lines = out.filter((l) => l.debit.gt(0) || l.credit.gt(0));
  return input.credit ? lines.map(flip) : lines;
}

/** Zahlungseingang: Bank an Debitor. Zahlungsausgang: Kreditor an Bank. */
export function paymentPosting(input: { bankAccountId: string; partyAccountId: string; amount: Decimal; incoming: boolean; text?: string }): PostingLine[] {
  return input.incoming
    ? [dr(input.bankAccountId, input.amount, { text: input.text }), cr(input.partyAccountId, input.amount)]
    : [dr(input.partyAccountId, input.amount, { text: input.text }), cr(input.bankAccountId, input.amount)];
}

/** Storno: dieselben Zeilen mit vertauschten Seiten. */
export function reversalLines(lines: PostingLine[]): PostingLine[] {
  return lines.map(flip);
}

// ───────────────────────── Auswertungen ─────────────────────────

export type AccountKind = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export const KIND_LABEL: Record<AccountKind, string> = { ASSET: "Aktiva (Vermögen)", LIABILITY: "Passiva (Fremdkapital)", EQUITY: "Eigenkapital", INCOME: "Ertrag", EXPENSE: "Aufwand" };

/** Einordnung eines Kontos: Personenkonten ergeben sich aus der Art, Sachkonten aus der gepflegten Einordnung. */
export function kindOf(a: { type: string; kind: string | null }): AccountKind | null {
  if (a.type === "CUSTOMER") return "ASSET";
  if (a.type === "VENDOR") return "LIABILITY";
  return (["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const).find((k) => k === a.kind) ?? null;
}

/** Normalseite der Einordnung: Aktiva und Aufwand im Soll, übrige im Haben. */
export const isDebitNormal = (k: AccountKind) => k === "ASSET" || k === "EXPENSE";

export interface AccountSums { accountId: string; number: string; name: string; kind: AccountKind | null; debit: Decimal; credit: Decimal }

/** Saldo auf der Normalseite des Kontos (positiv = übliche Seite). Ohne Einordnung: Soll minus Haben. */
export function balanceOf(s: { kind: AccountKind | null; debit: Decimal; credit: Decimal }): Decimal {
  return s.kind && !isDebitNormal(s.kind) ? s.credit.minus(s.debit) : s.debit.minus(s.credit);
}

export interface Statement {
  rows: { accountId: string; number: string; name: string; amount: Decimal }[];
  total: Decimal;
}

const section = (rows: AccountSums[], kind: AccountKind): Statement => {
  const list = rows.filter((r) => r.kind === kind).map((r) => ({ accountId: r.accountId, number: r.number, name: r.name, amount: balanceOf(r) })).filter((r) => !r.amount.isZero());
  return { rows: list.sort((a, b) => a.number.localeCompare(b.number, "de", { numeric: true })), total: sumOf(list.map((r) => r.amount)) };
};

/** Gewinn- und Verlustrechnung aus den Summen einer Periode. Ergebnis = Erträge − Aufwände. */
export function incomeStatement(rows: AccountSums[]) {
  const income = section(rows, "INCOME"), expense = section(rows, "EXPENSE");
  return { income, expense, result: income.total.minus(expense.total) };
}

/**
 * Bilanz zum Stichtag. `balanceRows`: Summen aller Bilanzkonten bis zum Stichtag, `retained`: Ergebnis aller früheren Geschäftsjahre,
 * `currentResult`: Ergebnis des laufenden Geschäftsjahres. Aktiva müssen Passiva (inklusive Eigenkapital und Ergebnis) entsprechen.
 */
export function balanceSheet(balanceRows: AccountSums[], retained: Decimal, currentResult: Decimal) {
  const assets = section(balanceRows, "ASSET"), liabilities = section(balanceRows, "LIABILITY"), equity = section(balanceRows, "EQUITY");
  const equityTotal = equity.total.plus(retained).plus(currentResult);
  const passivaTotal = liabilities.total.plus(equityTotal);
  return { assets, liabilities, equity, retained, currentResult, equityTotal, passivaTotal, difference: assets.total.minus(passivaTotal) };
}

/** Beginn des Geschäftsjahres (Monat 1–12) für ein Datum. */
export function fiscalYearStart(date: string, startMonth = 1): string {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, "0")}-01`;
}
