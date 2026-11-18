/** Statusregeln für Angebote – rein, ohne Datenbank. Datumsangaben als JJJJ-MM-TT. */
export type QuoteStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "SENT" | "ACCEPTED" | "DECLINED" | "CANCELLED";

export const QUOTE_LABEL: Record<QuoteStatus, string> = {
  DRAFT: "Entwurf", PENDING: "wartet auf Freigabe", APPROVED: "freigegeben", REJECTED: "abgelehnt (intern)", SENT: "versendet", ACCEPTED: "angenommen", DECLINED: "vom Kunden abgelehnt", CANCELLED: "verworfen",
};

const NEXT: Record<QuoteStatus, QuoteStatus[]> = {
  DRAFT: ["PENDING", "CANCELLED"],
  PENDING: ["APPROVED", "REJECTED", "CANCELLED"],
  APPROVED: ["SENT", "CANCELLED"],
  SENT: ["ACCEPTED", "DECLINED"],
  REJECTED: [], ACCEPTED: [], DECLINED: [], CANCELLED: [],
};

export function canTransition(from: QuoteStatus, to: QuoteStatus) {
  return NEXT[from].includes(to);
}

/** Ein Angebot ist am Tag der Gültigkeit noch gültig, danach abgelaufen. */
export function isExpired(validUntil: string, today: string) {
  return validUntil < today;
}

/** Anzeigestatus: versendete Angebote nach Ablauf als „abgelaufen“. */
export function displayStatus(status: QuoteStatus, validUntil: string, today: string) {
  return status === "SENT" && isExpired(validUntil, today) ? "abgelaufen" : QUOTE_LABEL[status];
}
