import { describe, expect, it } from "vitest";
import { definitionSchema, matches, render, safeHref } from "./engine";

const base = { key: "grosse-rechnung", name: "Große Rechnung", eventType: "customer_invoice.issued", actions: [{ type: "NOTIFY", recipient: { kind: "PERMISSION", permission: "finance.invoice.read" }, title: "Rechnung {{number}} über {{gross}} €" }] };

describe("Workflow-Engine", () => {
  it("prüft Definitionen gegen den Ereigniskatalog", () => {
    expect(definitionSchema.safeParse({ ...base, conditions: [{ field: "gross", op: "gt", value: "5 000" }] }).success).toBe(false); // keine Zahl
    expect(definitionSchema.safeParse({ ...base, conditions: [{ field: "gross", op: "gt", value: "5000" }] }).success).toBe(true);
    expect(definitionSchema.safeParse({ ...base, conditions: [{ field: "nix", op: "eq", value: "1" }] }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...base, conditions: [{ field: "gross", op: "contains", value: "1" }] }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...base, conditions: [{ field: "number", op: "gt", value: "1" }] }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...base, eventType: "unbekannt" }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...base, key: "Ungültig!" }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...base, actions: [{ ...base.actions[0], recipient: { kind: "PERMISSION", permission: "gibt.es.nicht" } }] }).success).toBe(false);
    expect(definitionSchema.safeParse({ ...base, conditions: Array(6).fill({ field: "gross", op: "gt", value: "1" }) }).success).toBe(false);
  });

  it("wertet Bedingungen exakt aus (Zahlen als Decimal, Text ohne Groß-/Kleinschreibung, UND-Verknüpfung)", () => {
    const p = { number: "AR-2027-0001", gross: "5000.01" };
    expect(matches([{ field: "gross", op: "gt", value: "5000" }], "customer_invoice.issued", p)).toBe(true);
    expect(matches([{ field: "gross", op: "lte", value: "5000,00" }], "customer_invoice.issued", p)).toBe(false);
    expect(matches([{ field: "gross", op: "eq", value: "5000.010" }], "customer_invoice.issued", p)).toBe(true);
    expect(matches([{ field: "number", op: "contains", value: "ar-2027" }, { field: "gross", op: "gte", value: "1" }], "customer_invoice.issued", p)).toBe(true);
    expect(matches([{ field: "number", op: "contains", value: "xx" }, { field: "gross", op: "gte", value: "1" }], "customer_invoice.issued", p)).toBe(false);
    expect(matches([], "customer_invoice.issued", p)).toBe(true); // ohne Bedingung immer
    expect(matches([{ field: "gross", op: "gt", value: "1" }], "customer_invoice.issued", {})).toBe(false); // Feld fehlt
    expect(matches([{ field: "gross", op: "gt", value: "1" }], "customer_invoice.issued", { gross: "kein Zahl" })).toBe(false);
    expect(matches([], "unbekannt", p)).toBe(false);
  });

  it("Vorlagen ersetzen nur deklarierte Felder und liefern reinen Text", () => {
    expect(render("Rechnung {{number}} über {{ gross }} €", "customer_invoice.issued", { number: "AR-1", gross: "120" })).toBe("Rechnung AR-1 über 120 €");
    expect(render("{{secret}} {{actorUserId}}|{{number}}", "customer_invoice.issued", { secret: "x", actorUserId: "u1", number: "N" })).toBe(" |N");
    expect(render("x".repeat(500), "customer_invoice.issued", {}, 50)).toHaveLength(50);
    expect(render("{{number}}", "customer_invoice.issued", { number: "<script>" })).toBe("<script>"); // wird von React maskiert, nie als HTML ausgegeben
  });

  it("nur interne Links", () => {
    expect(safeHref({ href: "/finance/out/abc" })).toBe("/finance/out/abc");
    expect(safeHref({ href: "//evil.example" })).toBeUndefined();
    expect(safeHref({ href: "https://evil.example" })).toBeUndefined();
    expect(safeHref({ href: "javascript:alert(1)" })).toBeUndefined();
    expect(safeHref({})).toBeUndefined();
  });
});
