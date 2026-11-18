import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}
const imports = (file: string) =>
  [...fs.readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
const rel = (f: string) => path.relative(SRC, f).replace(/\\/g, "/");

describe("Architekturregeln", () => {
  it("platform/ importiert keine Fachmodule", () => {
    const bad = files(path.join(SRC, "platform"))
      .filter((f) => !f.endsWith(".test.ts"))
      .flatMap((f) => imports(f).filter((i) => i.startsWith("@/modules/")).map((i) => `${rel(f)} -> ${i}`));
    expect(bad).toEqual([]);
  });

  it("Fachmodule greifen auf andere Module nur über service/queries zu", () => {
    const bad: string[] = [];
    for (const f of files(path.join(SRC, "modules")).filter((f) => !f.endsWith(".test.ts"))) {
      const own = rel(f).split("/")[1];
      for (const i of imports(f)) {
        const m = i.match(/^@\/modules\/([^/]+)\/(.+)$/);
        if (m && m[1] !== own && !["service", "queries"].includes(m[2]!)) bad.push(`${rel(f)} -> ${i}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("Server-Code im Browser-Bundle: kein 'use client' importiert Prisma, Datenbank oder Secrets", () => {
    const bad = files(SRC)
      .filter((f) => /^["']use client["']/.test(fs.readFileSync(f, "utf8").trimStart()))
      .flatMap((f) => imports(f).filter((i) => /@prisma|@\/lib\/db|@\/platform\/(auth|ai)|@\/modules\/.+\/service/.test(i)).map((i) => `${rel(f)} -> ${i}`));
    expect(bad).toEqual([]);
  });

  it("Kein NEXT_PUBLIC_-Schlüssel für Geheimnisse", () => {
    const bad = files(SRC).filter((f) => /NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN|PASSWORD)/.test(fs.readFileSync(f, "utf8")));
    expect(bad.map(rel)).toEqual([]);
  });

  it("Geld wird nicht mit Gleitkommazahlen berechnet (kein parseFloat/Number auf Beträgen in Services)", () => {
    const bad = files(path.join(SRC, "modules"))
      .filter((f) => /service\.ts$|queries\.ts$/.test(f))
      .filter((f) => /parseFloat|Number\(.*(amount|price|total)/i.test(fs.readFileSync(f, "utf8")));
    expect(bad.map(rel)).toEqual([]);
  });
});
