import { describe, expect, it } from "vitest";
import { isValidIban, issuerInput } from "./schema";

describe("Aussteller-Eingabe", () => {
  it("IBAN-Prüfsumme (mit und ohne Leerzeichen, Kleinbuchstaben)", () => {
    expect(isValidIban("AT61 1904 3002 3457 3201")).toBe(true);
    expect(isValidIban("de89370400440532013000")).toBe(true);
    expect(isValidIban("AT61 1904 3002 3457 3202")).toBe(false);
    expect(isValidIban("AT61")).toBe(false);
  });
  it("prüft UID, BIC und E-Mail; leere Felder werden zu null", () => {
    const ok = issuerInput.parse({ legalName: "Muster GmbH", uid: "ATU12345678", iban: "AT611904300234573201", bic: "BKAUATWW", email: "a@b.at", street: "" });
    expect(ok.street).toBeNull();
    expect(issuerInput.safeParse({ legalName: "x", uid: "12" }).success).toBe(false);
    expect(issuerInput.safeParse({ legalName: "x", bic: "123" }).success).toBe(false);
    expect(issuerInput.safeParse({ legalName: "x", email: "kein-mail" }).success).toBe(false);
    expect(issuerInput.safeParse({ legalName: "x", iban: "AT00 0000" }).success).toBe(false);
    expect(issuerInput.safeParse({ legalName: "  " }).success).toBe(false);
  });
});
