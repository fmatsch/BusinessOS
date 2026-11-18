import type { Decimal } from "@/lib/money";

/** Eine Zeile eines Belegs, bereits zusammengefasst nach Konto, Steuerkennzeichen und Kostenstelle. */
export interface ExportLine {
  account: string;
  /** Prozentsatz der Steuer; 0 = steuerfrei */
  rate: Decimal;
  bmdCode: string | null;
  datevKey: string | null;
  net: Decimal;
  tax: Decimal;
  gross: Decimal;
  costCenter: string | null;
}

export interface ExportVoucher {
  type: "SUPPLIER" | "CUSTOMER";
  /** INVOICE | CREDIT (Gutschrift: Soll und Haben vertauscht, Beträge bleiben positiv) */
  kind: "INVOICE" | "CREDIT";
  /** Belegdatum (Rechnungsdatum), ISO */
  date: string;
  dueDate: string | null;
  /** Rechnungsnummer des Lieferanten bzw. eigene Rechnungsnummer */
  documentNumber: string;
  /** interne Belegnummer (ER-2027-0001 / AR-2027-0001) */
  voucherNumber: string;
  personAccount: string;
  partnerName: string;
  uid: string | null;
  paymentTermsDays: number | null;
  lines: ExportLine[];
  /** Dateiname der Belegdatei im Belegpaket, falls vorhanden */
  fileName: string | null;
}

/** Soll- und Haben-Seite einer Zeile: Eingangsrechnung Aufwand an Kreditor, Ausgangsrechnung Debitor an Erlös; Gutschrift umgekehrt. */
export function sides(v: Pick<ExportVoucher, "type" | "kind">, lineAccount: string, personAccount: string) {
  const personDebit = (v.type === "CUSTOMER") === (v.kind === "INVOICE");
  return personDebit ? { debit: personAccount, credit: lineAccount, personIs: "debit" as const } : { debit: lineAccount, credit: personAccount, personIs: "credit" as const };
}

export interface FormatResult {
  fileName: string;
  /** Inhalt als Text (vor der Zeichensatz-Umwandlung) */
  content: string;
  /** Ausgabebytes in der Kodierung des Zielformats */
  bytes: Buffer;
  lineCount: number;
}
