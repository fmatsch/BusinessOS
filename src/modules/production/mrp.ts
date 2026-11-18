import { Decimal } from "@/lib/money";
import { componentQuantity, findCycle, type BomData } from "./bom";

/**
 * Bedarfsplanung (MRP, rein): Nettobedarf je Artikel aus Kundenbedarf, Bestand, geplanten Zugängen und Sicherheitsbestand,
 * über alle Stücklistenstufen (Dispositionsstufen). Das Ergebnis sind Vorschläge – es wird nichts gebucht.
 * Nicht berücksichtigt: Wiederbeschaffungszeiten, Losgrößen, Reservierungen, offene Bestellungen (Bestellpositionen kennen keine Artikel).
 */

export interface MrpItem { id: string; number: string; name: string; unit: string; onHand: Decimal; reorderLevel: Decimal | null; /** geplante Zugänge aus freigegebenen Fertigungsaufträgen */ plannedReceipts: Decimal }
export interface MrpInput {
  items: MrpItem[];
  /** unabhängiger Bedarf (Kundenaufträge, offene Menge) je Artikel */
  demand: Map<string, Decimal>;
  boms: BomData[];
}
export interface MrpSuggestion {
  itemId: string; number: string; name: string; unit: string;
  /** MAKE = Fertigungsauftrag vorschlagen, BUY = Beschaffung vorschlagen */
  action: "MAKE" | "BUY";
  quantity: Decimal;
  gross: Decimal; independent: Decimal; dependent: Decimal; onHand: Decimal; plannedReceipts: Decimal; safety: Decimal;
  level: number;
}

export function planMrp(input: MrpInput): MrpSuggestion[] {
  const cycle = findCycle(input.boms);
  if (cycle) throw new Error(`Zyklus in den Stücklisten: ${cycle.join(" → ")}`);
  const bomOf = new Map(input.boms.map((b) => [b.itemId, b]));
  const itemOf = new Map(input.items.map((i) => [i.id, i]));

  // Dispositionsstufe: längster Weg von einem Endprodukt bis zum Artikel (0 = nie Komponente)
  const level = new Map<string, number>();
  const setLevel = (id: string, l: number) => {
    if ((level.get(id) ?? -1) >= l) return;
    level.set(id, l);
    for (const line of bomOf.get(id)?.lines ?? []) setLevel(line.componentItemId, l + 1);
  };
  for (const i of input.items) if (!level.has(i.id)) setLevel(i.id, 0);
  // Artikel, die irgendwo Komponente sind, erhalten durch die Rekursion die höhere Stufe, auch wenn sie zuerst als Stufe 0 gesetzt wurden
  const order = [...new Set([...input.items.map((i) => i.id), ...input.boms.flatMap((b) => b.lines.map((l) => l.componentItemId))])]
    .filter((id) => itemOf.has(id))
    .sort((a, b) => (level.get(a) ?? 0) - (level.get(b) ?? 0));

  const dependent = new Map<string, Decimal>();
  const out: MrpSuggestion[] = [];
  for (const id of order) {
    const item = itemOf.get(id)!;
    const independent = input.demand.get(id) ?? new Decimal(0);
    const dep = dependent.get(id) ?? new Decimal(0);
    const gross = independent.plus(dep);
    const safety = item.reorderLevel ?? new Decimal(0);
    const net = Decimal.max(0, gross.plus(safety).minus(item.onHand).minus(item.plannedReceipts));
    if (net.lte(0)) continue;
    const bom = bomOf.get(id);
    out.push({ itemId: id, number: item.number, name: item.name, unit: item.unit, action: bom ? "MAKE" : "BUY", quantity: net, gross, independent, dependent: dep, onHand: item.onHand, plannedReceipts: item.plannedReceipts, safety, level: level.get(id) ?? 0 });
    if (bom) for (const line of bom.lines) dependent.set(line.componentItemId, (dependent.get(line.componentItemId) ?? new Decimal(0)).plus(componentQuantity(line, bom.outputQuantity, net)));
  }
  return out.sort((a, b) => a.level - b.level || a.number.localeCompare(b.number));
}
