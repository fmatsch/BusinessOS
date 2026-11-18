import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { componentQuantity, explode, findCycle, type BomData } from "./bom";
import { planMrp, type MrpItem } from "./mrp";

const D = (v: string) => new Decimal(v);
const line = (id: string, q: string, scrap = "0") => ({ componentItemId: id, quantity: D(q), scrapPercent: D(scrap) });
const bom = (itemId: string, lines: ReturnType<typeof line>[], out = "1"): BomData => ({ itemId, outputQuantity: D(out), lines });
const item = (id: string, onHand = "0", reorder: string | null = null, planned = "0"): MrpItem => ({ id, number: id.toUpperCase(), name: id, unit: "Stk", onHand: D(onHand), reorderLevel: reorder ? D(reorder) : null, plannedReceipts: D(planned) });

describe("Stückliste", () => {
  it("Komponentenmenge: Basismenge, Ausschuss, aufgerundet auf 4 Stellen", () => {
    expect(componentQuantity(line("s", "4"), D("2"), D("10")).toString()).toBe("20"); // 4 je 2 Stück → 20 für 10
    expect(componentQuantity(line("s", "1", "10"), D("1"), D("3")).toString()).toBe("3.3"); // 10 % Ausschuss
    expect(componentQuantity(line("s", "1"), D("3"), D("1")).toString()).toBe("0.3334"); // 0,3333… aufgerundet
  });
  it("Zyklen werden erkannt (direkt und indirekt), gültige Strukturen nicht", () => {
    expect(findCycle([bom("a", [line("b", "1")]), bom("b", [line("c", "1")])])).toBeNull();
    expect(findCycle([bom("a", [line("a", "1")])])).toEqual(["a", "a"]);
    expect(findCycle([bom("a", [line("b", "1")]), bom("b", [line("c", "1")]), bom("c", [line("a", "1")])])).toEqual(["a", "b", "c", "a"]);
    // dieselbe Komponente an zwei Stellen ist kein Zyklus
    expect(findCycle([bom("a", [line("b", "1"), line("c", "1")]), bom("b", [line("c", "1")])])).toBeNull();
  });
  it("mehrstufige Auflösung summiert gleiche Komponenten und markiert Kaufteile", () => {
    const boms = new Map([bom("fahrrad", [line("rad", "2"), line("rahmen", "1")]), bom("rad", [line("speiche", "36"), line("felge", "1")])].map((b) => [b.itemId, b]));
    const r = explode(boms, "fahrrad", D("3"));
    const q = Object.fromEntries(r.map((x) => [x.itemId, [x.quantity.toString(), x.level, x.leaf]]));
    expect(q).toEqual({ rad: ["6", 1, false], rahmen: ["3", 1, true], speiche: ["216", 2, true], felge: ["6", 2, true] });
  });
});

describe("Bedarfsplanung (MRP)", () => {
  const boms = [bom("fahrrad", [line("rad", "2"), line("rahmen", "1")]), bom("rad", [line("speiche", "36")])];
  it("Nettobedarf über mehrere Stufen: Fertigung für Endprodukt und Zwischenprodukt, Kauf für Rohstoffe", () => {
    const r = planMrp({
      items: [item("fahrrad", "2"), item("rad", "4"), item("rahmen", "0"), item("speiche", "100")],
      demand: new Map([["fahrrad", D("10")]]),
      boms,
    });
    const by = Object.fromEntries(r.map((s) => [s.itemId, [s.action, s.quantity.toString()]]));
    expect(by.fahrrad).toEqual(["MAKE", "8"]); // 10 − 2 Bestand
    expect(by.rad).toEqual(["MAKE", "12"]); // 16 benötigt − 4 Bestand
    expect(by.rahmen).toEqual(["BUY", "8"]);
    expect(by.speiche).toEqual(["BUY", "332"]); // 12 × 36 = 432 − 100
    expect(r[0]!.itemId).toBe("fahrrad"); // Stufe 0 zuerst
  });
  it("geplante Zugänge und Sicherheitsbestand gehen in den Nettobedarf ein; ohne Bedarf kein Vorschlag", () => {
    const none = planMrp({ items: [item("a", "5", "5")], demand: new Map(), boms: [] });
    expect(none).toEqual([]); // Bestand = Sicherheitsbestand
    const r = planMrp({ items: [item("a", "3", "5", "1")], demand: new Map([["a", D("4")]]), boms: [] });
    expect(r[0]!.quantity.toString()).toBe("5"); // 4 + 5 − 3 − 1
    expect([r[0]!.gross.toString(), r[0]!.safety.toString()]).toEqual(["4", "5"]);
  });
  it("ein Artikel auf mehreren Stufen wird erst nach allen Bedarfen disponiert", () => {
    // schraube ist Komponente von a (Stufe 1) und von b (Stufe 2, b ist Komponente von a)
    const bs = [bom("a", [line("b", "1"), line("schraube", "2")]), bom("b", [line("schraube", "3")])];
    const r = planMrp({ items: [item("a"), item("b"), item("schraube")], demand: new Map([["a", D("10")]]), boms: bs });
    const s = r.find((x) => x.itemId === "schraube")!;
    expect(s.quantity.toString()).toBe("50"); // 10 × 2 + 10 × 3
    expect(s.level).toBe(2);
  });
  it("Zyklen in Stücklisten werden abgewiesen", () => {
    expect(() => planMrp({ items: [item("a"), item("b")], demand: new Map([["a", D("1")]]), boms: [bom("a", [line("b", "1")]), bom("b", [line("a", "1")])] })).toThrow(/Zyklus/);
  });
});
