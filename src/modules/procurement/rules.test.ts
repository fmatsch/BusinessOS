import { describe, expect, it } from "vitest";
import { computeTotal } from "./rules";

describe("computeTotal", () => {
  it("rechnet ohne Gleitkommafehler", () => {
    const t = computeTotal([
      { quantity: "3", unitPrice: "0.1" },
      { quantity: "1", unitPrice: "0.2" },
    ]);
    expect(t.toString()).toBe("0.5");
  });
});
