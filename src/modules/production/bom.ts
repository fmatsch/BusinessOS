import { Decimal } from "@/lib/money";

/** Stücklisten-Rechnung (rein, ohne Datenbank): Mengenbedarf, Auflösung über mehrere Stufen, Zyklenprüfung. */

export interface BomLineData { componentItemId: string; quantity: Decimal; scrapPercent: Decimal }
export interface BomData { itemId: string; /** Menge des Endprodukts, auf die sich die Zeilen beziehen (Basismenge) */ outputQuantity: Decimal; lines: BomLineData[] }

/** Benötigte Menge einer Komponente für `produced` Stück Endprodukt inklusive Ausschuss, aufgerundet auf 4 Nachkommastellen. */
export function componentQuantity(line: BomLineData, outputQuantity: Decimal, produced: Decimal): Decimal {
  return line.quantity.times(produced).div(outputQuantity).times(new Decimal(1).plus(line.scrapPercent.div(100))).toDecimalPlaces(4, Decimal.ROUND_UP);
}

/** Findet einen Zyklus (Artikel kommt direkt oder indirekt in der eigenen Stückliste vor). Gibt den Pfad zurück oder `null`. */
export function findCycle(boms: BomData[]): string[] | null {
  const byItem = new Map(boms.map((b) => [b.itemId, b]));
  const state = new Map<string, 1 | 2>(); // 1 = in Bearbeitung, 2 = fertig
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const l of byItem.get(id)?.lines ?? []) { const c = visit(l.componentItemId); if (c) return c; }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const b of boms) { const c = visit(b.itemId); if (c) return c; }
  return null;
}

export interface Exploded { itemId: string; quantity: Decimal; /** größte Stufe, auf der der Artikel vorkommt (1 = direkte Komponente) */ level: number; /** true = Kaufteil/Rohstoff (keine eigene Stückliste) */ leaf: boolean }

/** Mehrstufige Auflösung: gesamter Bedarf je Artikel für `quantity` Stück. Zwischenprodukte erscheinen ebenfalls (leaf = false). */
export function explode(boms: Map<string, BomData>, itemId: string, quantity: Decimal): Exploded[] {
  const out = new Map<string, Exploded>();
  const walk = (id: string, qty: Decimal, level: number, path: string[]) => {
    const bom = boms.get(id);
    if (!bom) return;
    for (const line of bom.lines) {
      if (path.includes(line.componentItemId)) throw new Error("Zyklus in der Stückliste");
      const q = componentQuantity(line, bom.outputQuantity, qty);
      const prev = out.get(line.componentItemId);
      out.set(line.componentItemId, { itemId: line.componentItemId, quantity: (prev?.quantity ?? new Decimal(0)).plus(q), level: Math.max(prev?.level ?? 0, level), leaf: !boms.has(line.componentItemId) });
      walk(line.componentItemId, q, level + 1, [...path, line.componentItemId]);
    }
  };
  walk(itemId, quantity, 1, [itemId]);
  return [...out.values()].sort((a, b) => a.level - b.level || a.itemId.localeCompare(b.itemId));
}
