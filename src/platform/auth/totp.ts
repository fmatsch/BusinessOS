import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Einmalpasswörter nach RFC 4226 (HOTP) und RFC 6238 (TOTP): HMAC-SHA1, 30 Sekunden, 6 Stellen – kompatibel mit gängigen Authenticator-Apps. */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Ungültiges Base32-Zeichen");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepOf = (nowMs: number) => Math.floor(nowMs / 1000 / STEP_SECONDS);
export const totp = (secret: Buffer, nowMs: number, digits = DIGITS) => hotp(secret, stepOf(nowMs), digits);

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Prüft einen Code im Fenster ±`window` Schritte (Uhrabweichung). Gibt den passenden Zeitschritt zurück oder `null`.
 * Der Aufrufer merkt sich den Schritt und lehnt gleiche oder frühere ab (Schutz gegen Wiederverwendung).
 */
export function verifyTotp(secretBase32: string, code: string, nowMs = Date.now(), window = 1): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretBase32);
  const step = stepOf(nowMs);
  let hit: number | null = null;
  for (let s = step - window; s <= step + window; s++) if (safeEqual(hotp(secret, s), clean)) hit = s; // ohne vorzeitigen Abbruch
  return hit;
}

export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ───────────────────────── Wiederherstellungscodes ─────────────────────────

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // ohne leicht verwechselbare Zeichen
export const RECOVERY_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const raw = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Schreibweise vereinheitlichen (Groß-/Kleinschreibung, Bindestrich, Leerzeichen), dann hashen. */
export const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[\s-]/g, "");
export const hashRecovery = (code: string) => createHash("sha256").update(normalizeRecovery(code)).digest("hex");
export const looksLikeRecovery = (code: string) => /^[a-z2-9]{10}$/.test(normalizeRecovery(code));
