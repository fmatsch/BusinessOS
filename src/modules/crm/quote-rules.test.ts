import { describe, expect, it } from "vitest";
import { canTransition, displayStatus, isExpired } from "./quote-rules";

describe("Angebotsstatus", () => {
  it("erlaubt nur den vorgesehenen Ablauf", () => {
    expect(canTransition("DRAFT", "PENDING")).toBe(true);
    expect(canTransition("PENDING", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "SENT")).toBe(true);
    expect(canTransition("SENT", "ACCEPTED")).toBe(true);
    expect(canTransition("DRAFT", "SENT")).toBe(false); // nie ohne Freigabe
    expect(canTransition("PENDING", "SENT")).toBe(false);
    expect(canTransition("SENT", "CANCELLED")).toBe(false); // Versendetes wird abgelehnt, nicht verworfen
    for (const end of ["ACCEPTED", "DECLINED", "REJECTED", "CANCELLED"] as const) expect(canTransition(end, "DRAFT")).toBe(false);
  });
  it("Ablauf: am Gültigkeitstag noch gültig", () => {
    expect(isExpired("2027-03-10", "2027-03-10")).toBe(false);
    expect(isExpired("2027-03-10", "2027-03-11")).toBe(true);
    expect(displayStatus("SENT", "2027-03-10", "2027-03-11")).toBe("abgelaufen");
    expect(displayStatus("ACCEPTED", "2027-03-10", "2027-03-11")).toBe("angenommen");
  });
});
