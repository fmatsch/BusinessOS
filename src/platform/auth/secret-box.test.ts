import { describe, expect, it } from "vitest";
import { open, seal } from "./secret-box";
import { passwordProblem } from "./password";

const env = { AUTH_SECRET: "test-secret-1" } as unknown as NodeJS.ProcessEnv;

describe("Geheimnisse verschlüsseln", () => {
  it("Rundlauf, jedes Mal anderer Nonce, kein Klartext im Ergebnis", () => {
    const a = seal("JBSWY3DPEHPK3PXP", env), b = seal("JBSWY3DPEHPK3PXP", env);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(a).not.toContain("JBSWY3DPEHPK3PXP");
    expect(open(a, env)).toBe("JBSWY3DPEHPK3PXP");
  });
  it("Manipulation, falscher Schlüssel und falsches Format werden erkannt", () => {
    const s = seal("geheim", env);
    const parts = s.split(".");
    const flipped = [...parts.slice(0, 3), Buffer.from(Buffer.from(parts[3]!, "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url")].join(".");
    expect(() => open(flipped, env)).toThrow();
    expect(() => open(s, { AUTH_SECRET: "anderes-geheimnis" } as unknown as NodeJS.ProcessEnv)).toThrow();
    expect(() => open("v2.a.b.c", env)).toThrow(/Format/);
    expect(() => open("unsinn", env)).toThrow();
  });
  it("eigener Schlüssel: Hex oder Base64, genau 32 Byte; ohne jede Quelle Fehler", () => {
    const hex = "ab".repeat(32);
    expect(open(seal("x", { MFA_ENCRYPTION_KEY: hex } as unknown as NodeJS.ProcessEnv), { MFA_ENCRYPTION_KEY: hex } as unknown as NodeJS.ProcessEnv)).toBe("x");
    const b64 = Buffer.alloc(32, 7).toString("base64");
    expect(open(seal("y", { MFA_ENCRYPTION_KEY: b64 } as unknown as NodeJS.ProcessEnv), { MFA_ENCRYPTION_KEY: b64 } as unknown as NodeJS.ProcessEnv)).toBe("y");
    expect(() => seal("z", { MFA_ENCRYPTION_KEY: "zu-kurz" } as unknown as NodeJS.ProcessEnv)).toThrow(/32 Byte/);
    expect(() => seal("z", {} as unknown as NodeJS.ProcessEnv)).toThrow(/AUTH_SECRET/);
  });
});

describe("Passwortregeln", () => {
  it("Mindestlänge und Höchstlänge", () => {
    expect(passwordProblem("kurz")).toMatch(/mindestens 12/);
    expect(passwordProblem("a".repeat(201))).toMatch(/höchstens/);
    expect(passwordProblem("ein-langes-passwort-ohne-sonderfall")).toBeNull();
  });
  it("verbreitete, einförmige und persönliche Passwörter werden abgewiesen", () => {
    expect(passwordProblem("Passwort1234")).toMatch(/verbreitet/);
    expect(passwordProblem("aaaaaaaaaaaaaa")).toMatch(/einzigen Zeichen/);
    expect(passwordProblem("xxanna.mustermannxx", { email: "anna.mustermann@firma.example" })).toMatch(/Namen aus der E-Mail/);
    expect(passwordProblem("anna.mustermann@firma.example!", { email: "anna.mustermann@firma.example" })).toMatch(/E-Mail-Adresse/);
    expect(passwordProblem("Ich heisse Maria Beispiel!", { name: "Maria Beispiel" })).toMatch(/Namen/);
    expect(passwordProblem("zufaelliges-Pferd-Batterie-7", { email: "a@b.example", name: "Max" })).toBeNull();
  });
});
