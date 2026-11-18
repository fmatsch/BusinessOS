import { describe, expect, it } from "vitest";
import { Decimal } from "@/lib/money";
import { valueMovements, type ValuationInput } from "./valuation";

const mv = (id: string, kind: string, q: string, cost: string | null = null, reversesId: string | null = null): ValuationInput => ({ id, kind, quantity: new Decimal(q), unitCost: cost === null ? null : new Decimal(cost), reversesId });
const seq = [mv("a", "RECEIPT", "10", "2"), mv("b", "RECEIPT", "10", "4"), mv("c", "ISSUE", "-15")];

describe("Lagerbewertung", () => {
  it("gleitender Durchschnitt: Ausgabe zum Durchschnitt", () => {
    const r = valueMovements("AVG", seq);
    expect(r.movements.map((m) => m.value.toString())).toEqual(["20", "40", "-45"]); // Ø 3 × 15
    expect(r.quantity.toString()).toBe("5");
    expect(r.value.toString()).toBe("15");
    expect(r.averageCost.toString()).toBe("3");
  });
  it("FIFO: älteste Zugänge zuerst", () => {
    const r = valueMovements("FIFO", seq);
    expect(r.movements[2]!.value.toString()).toBe("-40"); // 10×2 + 5×4
    expect(r.value.toString()).toBe("20");
    expect(r.averageCost.toString()).toBe("4");
  });
  it("vollständiger Abbau lässt keinen Restwert zurück (Rundung)", () => {
    const r = valueMovements("AVG", [mv("a", "RECEIPT", "3", "1.111111"), mv("b", "ISSUE", "-1"), mv("c", "ISSUE", "-2")]);
    expect(r.quantity.toString()).toBe("0");
    expect(r.value.toString()).toBe("0");
  });
  it("Gegenbuchung einer Entnahme geht zum Wert der Entnahme zurück", () => {
    const r = valueMovements("AVG", [...seq, mv("d", "REVERSAL", "15", null, "c")]);
    expect(r.movements[3]!.value.toString()).toBe("45");
    expect(r.value.toString()).toBe("60");
    expect(r.quantity.toString()).toBe("20");
  });
  it("Umbuchungen ändern den Wert nicht; Inventurzugang ohne Preis zum Durchschnitt", () => {
    const r = valueMovements("AVG", [mv("a", "RECEIPT", "10", "2"), mv("t1", "TRANSFER_OUT", "-4"), mv("t2", "TRANSFER_IN", "4"), mv("x", "ADJUST", "5")]);
    expect(r.movements.map((m) => m.id)).toEqual(["a", "x"]);
    expect(r.value.toString()).toBe("30");
    expect(r.quantity.toString()).toBe("15");
  });
  it("negative Wareneingänge (Korrektur) werden wie Entnahmen bewertet; leeres Lager", () => {
    const r = valueMovements("FIFO", [mv("a", "RECEIPT", "10", "2"), mv("b", "RECEIPT", "-4")]);
    expect(r.value.toString()).toBe("12");
    expect(valueMovements("AVG", []).value.toString()).toBe("0");
  });
});
