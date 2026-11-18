import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimit } from "./rate-limit";

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
});
