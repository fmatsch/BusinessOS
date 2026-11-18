import { describe, expect, it } from "vitest";
import { costCenterInput, departmentInput } from "./schema";

describe("Eingabevalidierung", () => {
  it("akzeptiert gültige Abteilung", () => {
    expect(departmentInput.parse({ code: "IT-1", name: " IT " }).name).toBe("IT");
  });
  it("lehnt Sonderzeichen im Code und leere Namen ab", () => {
    expect(departmentInput.safeParse({ code: "a b;", name: "x" }).success).toBe(false);
    expect(costCenterInput.safeParse({ code: "K1", name: "  " }).success).toBe(false);
  });
});
