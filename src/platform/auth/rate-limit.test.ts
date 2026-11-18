import { beforeEach, describe, expect, it } from "vitest";
import { clearKey, isLimited, rateLimit, recordHit, resetRateLimit } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(resetRateLimit);
  it("blockiert nach dem Limit und gibt nach dem Fenster wieder frei", () => {
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 1000, 0)).toBe(true);
    expect(rateLimit("k", 3, 1000, 10)).toBe(false);
    expect(rateLimit("k", 3, 1000, 2000)).toBe(true);
  });
  it("trennt Schlüssel", () => {
    expect(rateLimit("a", 1, 1000, 0)).toBe(true);
    expect(rateLimit("b", 1, 1000, 0)).toBe(true);
  });
  it("isLimited zählt nur aufgezeichnete Fehlversuche; clearKey setzt zurück", () => {
    for (let i = 0; i < 5; i++) {
      expect(isLimited("login:x", 5, 1000, i)).toBe(false); // Prüfen allein zählt nicht
      recordHit("login:x", i);
    }
    expect(isLimited("login:x", 5, 1000, 10)).toBe(true);
    expect(isLimited("login:x", 5, 1000, 5000)).toBe(false); // Fenster abgelaufen
    recordHit("login:x", 5000);
    clearKey("login:x");
    expect(isLimited("login:x", 1, 1000, 5001)).toBe(false);
  });
});
