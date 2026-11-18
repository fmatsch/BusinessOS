import { createHash } from "node:crypto";

/** Windows-1252 („ANSI") für die Zeichen 0x80–0x9F, die von Latin-1 abweichen. */
const CP1252_HIGH: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/** Kodiert nach Windows-1252; nicht darstellbare Zeichen werden zu „?" (kein stilles Verfälschen von Umlauten oder €). */
export function encodeCp1252(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff)) out.push(cp);
    else if (CP1252_HIGH[ch] !== undefined) out.push(CP1252_HIGH[ch]!);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}

export const sha256Hex = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");

export const pad2 = (n: number) => String(n).padStart(2, "0");

/** ISO-Datum → Zeichenfolgen der Zielformate. */
export const dateParts = (iso: string) => ({ y: iso.slice(0, 4), m: iso.slice(5, 7), d: iso.slice(8, 10) });

/** Betrag mit Dezimalkomma, zwei Nachkommastellen, ohne Tausendertrennung. */
export function amountDe(value: { toFixed(n: number): string } | number): string {
  const v = typeof value === "number" ? value : value.toFixed(2);
  return (typeof v === "number" ? v.toFixed(2) : v).replace(".", ",");
}
