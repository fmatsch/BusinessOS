import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { billingLines, isOrderDone, openQuantities, overDelivery } from "./delivery";

const D = (v: string) => new Decimal(v);
const lines = [{ id: "a", quantity: D("10") }, { id: "b", quantity: D("5") }];

describe("Lieferung und Abrechnung", () => {
  it("offene Mengen berücksichtigen Geliefertes und Eingeplantes", () => {
    const o = openQuantities(lines, new Map([["a", D("4")]]));
    expect(o.map((x) => x.open.toString())).toEqual(["6", "5"]);
    expect(openQuantities(lines, new Map([["a", D("12")]]))[0]!.open.toString()).toBe("0"); // nie negativ
  });
  it("Übermengen und fremde Positionen werden abgewiesen, auch über mehrere Zeilen summiert", () => {
    const o = openQuantities(lines, new Map([["a", D("4")]]));
    expect(overDelivery(o, [{ orderLineId: "a", quantity: D("6") }])).toBeNull();
    expect(overDelivery(o, [{ orderLineId: "a", quantity: D("7") }])).toMatch(/nur noch 6 offen/);
    expect(overDelivery(o, [{ orderLineId: "a", quantity: D("3") }, { orderLineId: "a", quantity: D("4") }])).toMatch(/nur noch 6 offen/);
    expect(overDelivery(o, [{ orderLineId: "x", quantity: D("1") }])).toMatch(/gehört nicht/);
  });
  it("Rechnungspositionen: nur Gelieferte, zusammengefasst, in Auftragsreihenfolge", () => {
    const ol = [
      { id: "a", description: "Teil A", unitPrice: D("2.5"), taxCodeId: "t", revenueAccountId: null },
      { id: "b", description: "Teil B", unitPrice: D("10"), taxCodeId: "t", revenueAccountId: "r" },
    ];
    const r = billingLines(ol, [{ orderLineId: "b", quantity: D("1") }, { orderLineId: "a", quantity: D("2") }, { orderLineId: "a", quantity: D("3") }]);
    expect(r.map((x) => [x.orderLineId, x.quantity.toString()])).toEqual([["a", "5"], ["b", "1"]]);
    expect(billingLines(ol, [])).toEqual([]);
  });
  it("erledigt = vollständig geliefert und abgerechnet", () => {
    const shipped = new Map([["a", D("10")], ["b", D("5")]]);
    expect(isOrderDone(lines, shipped, new Map([["a", D("10")], ["b", D("5")]]))).toBe(true);
    expect(isOrderDone(lines, shipped, new Map([["a", D("10")]]))).toBe(false);
    expect(isOrderDone(lines, new Map([["a", D("10")]]), new Map([["a", D("10")], ["b", D("5")]]))).toBe(false);
    expect(isOrderDone([], new Map(), new Map())).toBe(false);
  });
});
