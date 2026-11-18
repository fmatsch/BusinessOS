import { zipSync } from "fflate";

export interface PackageFile { name: string; data: Uint8Array }

/**
 * Belegpaket als ZIP. Dateinamen im Paket sind eindeutig und frei von Pfadbestandteilen; die Reihenfolge ist fest, der Zeitstempel konstant,
 * damit dasselbe Paket immer dieselben Bytes (und denselben Hash) ergibt.
 */
export function buildPackage(files: PackageFile[]): Uint8Array {
  const entries: Record<string, [Uint8Array, { mtime: Date; level: 0 }]> = {};
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries[f.name]) throw new Error(`Doppelter Dateiname im Belegpaket: ${f.name}`);
    entries[f.name] = [f.data, { mtime: new Date(Date.UTC(1980, 0, 1)), level: 0 }];
  }
  return zipSync(entries);
}

/** Sicherer Dateiname für Belege im Paket: nur Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich. */
export function packageFileName(voucherNumber: string, original: string): string {
  const dot = original.lastIndexOf(".");
  const ext = dot > 0 ? original.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) : "bin";
  return `${voucherNumber.replace(/[^A-Za-z0-9_-]/g, "_")}.${ext || "bin"}`;
}
