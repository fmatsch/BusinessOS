import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateRecoveryCodes, generateSecret, hashRecovery, hotp, looksLikeRecovery, normalizeRecovery, otpauthUri, totp, verifyTotp } from "./totp";

// Testvektoren aus RFC 4226 (HOTP) und RFC 6238 (TOTP, SHA-1, Geheimnis "12345678901234567890")
const rfcSecret = Buffer.from("12345678901234567890");

describe("HOTP/TOTP", () => {
  it("HOTP: Testvektoren aus RFC 4226", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(rfcSecret, counter)).toBe(code));
  });
  it("TOTP: Testvektoren aus RFC 6238 (letzte 6 Stellen der 8-stelligen Werte)", () => {
    const cases: [number, string][] = [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"]];
    for (const [t, code] of cases) expect(totp(rfcSecret, t * 1000)).toBe(code);
    expect(totp(rfcSecret, 59_000, 8)).toBe("94287082"); // der Vektor mit 8 Stellen
  });
  it("Base32: Rundlauf und RFC-4648-Vektoren", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI").toString()).toBe("foobar");
    expect(base32Decode("mzxw 6ytb-oi").toString()).toBe("foobar"); // Leerzeichen, Bindestriche, Kleinschreibung
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(() => base32Decode("1!")).toThrow();
  });
  it("Prüfung: Fenster ±1 Schritt, falsche und fehlgeformte Codes, gibt den Zeitschritt zurück", () => {
    const secret = base32Encode(rfcSecret);
    const now = 1111111111_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, "050471", now)).toBe(step);
    expect(verifyTotp(secret, "05 04 71", now)).toBe(step); // Leerzeichen erlaubt
    expect(verifyTotp(secret, "081804", now)).toBe(step - 1); // vorheriger Schritt (Uhr geht nach)
    expect(verifyTotp(secret, "081804", now + 30_000)).toBeNull(); // schon zwei Schritte her: zu alt
    expect(verifyTotp(secret, "287082", now - 30_000 * 1_000_000)).toBeNull(); // weit entfernte Zeit
    expect(verifyTotp(secret, "000000", now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", now)).toBeNull();
    expect(verifyTotp(secret, "0504711", now)).toBeNull();
  });
  it("otpauth-URI für Authenticator-Apps", () => {
    expect(otpauthUri("BusinessOS", "anna@firma.example", "ABC234")).toBe("otpauth://totp/BusinessOS:anna%40firma.example?secret=ABC234&issuer=BusinessOS&algorithm=SHA1&digits=6&period=30");
  });
});

describe("Wiederherstellungscodes", () => {
  it("zehn eindeutige Codes im Format xxxxx-xxxxx", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) { expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/); expect(looksLikeRecovery(c)).toBe(true); }
  });
  it("Schreibweise egal, Hash stabil; TOTP-Codes werden nicht für Wiederherstellungscodes gehalten", () => {
    expect(normalizeRecovery(" ABCDE-fghjk ")).toBe("abcdefghjk");
    expect(hashRecovery("ABCDE-FGHJK")).toBe(hashRecovery("abcde fghjk"));
    expect(hashRecovery("abcde-fghjk")).not.toBe(hashRecovery("abcde-fghjm"));
    expect(looksLikeRecovery("123456")).toBe(false);
  });
});
