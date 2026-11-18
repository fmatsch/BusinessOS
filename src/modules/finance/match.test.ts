import { describe, expect, it } from "vitest";
import { matchInvoice } from "./match";

const base = { orderedNet: "3000", receivedNet: "3000", alreadyInvoicedNet: "0" };

describe("Rechnungsabgleich (rein)", () => {
  it("passt bei voller Lieferung und genauer Rechnung", () => {
    expect(matchInvoice({ ...base, invoiceNet: "3000" }).status).toBe("OK");
  });
  it("Teillieferung: Rechnung über die gelieferte Menge ist ok, darüber nicht", () => {
    const partial = { orderedNet: "3000", receivedNet: "1000", alreadyInvoicedNet: "0" };
    expect(matchInvoice({ ...partial, invoiceNet: "1000" }).status).toBe("OK");
    const r = matchInvoice({ ...partial, invoiceNet: "3000" });
    expect(r.status).toBe("VARIANCE");
    expect(r.variances.map((v) => v.code)).toEqual(["EXCEEDS_RECEIVED"]);
    expect(r.variances[0]!.excess.toString()).toBe("2000");
  });
  it("bereits abgerechnetes wird abgezogen", () => {
    expect(matchInvoice({ orderedNet: "3000", receivedNet: "3000", alreadyInvoicedNet: "2000", invoiceNet: "1000" }).status).toBe("OK");
    expect(matchInvoice({ orderedNet: "3000", receivedNet: "3000", alreadyInvoicedNet: "2000", invoiceNet: "1500" }).status).toBe("VARIANCE");
  });
  it("Toleranz: die größere von 2 % und 5 € gilt", () => {
    expect(matchInvoice({ ...base, invoiceNet: "3061" }).status).toBe("OK"); // 2 % der Rechnung = 61,22 €
    expect(matchInvoice({ ...base, invoiceNet: "3063" }).status).toBe("VARIANCE");
    expect(matchInvoice({ orderedNet: "100", receivedNet: "100", alreadyInvoicedNet: "0", invoiceNet: "104.99" }).status).toBe("OK"); // 5 € bei kleinen Beträgen
    expect(matchInvoice({ orderedNet: "100", receivedNet: "100", alreadyInvoicedNet: "0", invoiceNet: "105.01" }).status).toBe("VARIANCE");
  });
  it("Rechnung über den Bestellwert hinaus wird gemeldet, auch bei gelieferter Übermenge", () => {
    const r = matchInvoice({ orderedNet: "1000", receivedNet: "2000", alreadyInvoicedNet: "0", invoiceNet: "2000" });
    expect(r.variances.map((v) => v.code)).toEqual(["EXCEEDS_ORDER"]);
  });
  it("nichts geliefert: jede Rechnung über der Toleranz weicht ab", () => {
    expect(matchInvoice({ orderedNet: "500", receivedNet: "0", alreadyInvoicedNet: "0", invoiceNet: "500" }).status).toBe("VARIANCE");
    expect(matchInvoice({ orderedNet: "500", receivedNet: "0", alreadyInvoicedNet: "0", invoiceNet: "4" }).status).toBe("OK");
  });
  it("Dezimalrechnung ist exakt (0,1 + 0,2)", () => {
    expect(matchInvoice({ orderedNet: "0.30", receivedNet: "0.1", alreadyInvoicedNet: "0.2", invoiceNet: "0" }).status).toBe("OK");
  });
});
