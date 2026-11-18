import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Verschlüsselt kleine Geheimnisse (z. B. das TOTP-Geheimnis) vor dem Speichern: AES-256-GCM mit zufälligem Nonce, Format `v1.<nonce>.<tag>.<daten>` (Base64URL).
 * Schlüssel: `MFA_ENCRYPTION_KEY` (32 Byte, Base64 oder Hex); fehlt er, wird er per HKDF aus `AUTH_SECRET` abgeleitet.
 * Wird der Schlüssel geändert, sind gespeicherte Geheimnisse nicht mehr lesbar – dann müssen Zwei-Faktor-Zugänge neu eingerichtet werden.
 */

function key(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.MFA_ENCRYPTION_KEY?.trim();
  if (raw) {
    const b = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (b.length !== 32) throw new Error("MFA_ENCRYPTION_KEY muss 32 Byte lang sein (Base64 oder 64 Hex-Zeichen)");
    return b;
  }
  const secret = env.AUTH_SECRET;
  if (!secret) throw new Error("Weder MFA_ENCRYPTION_KEY noch AUTH_SECRET ist gesetzt");
  return Buffer.from(hkdfSync("sha256", createHash("sha256").update(secret).digest(), Buffer.alloc(0), "businessos-mfa-v1", 32));
}

const b64 = (b: Buffer) => b.toString("base64url");

export function seal(plain: string, env?: NodeJS.ProcessEnv): string {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(env), nonce);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", b64(nonce), b64(c.getAuthTag()), b64(data)].join(".");
}

/** Entschlüsselt; wirft bei Manipulation oder falschem Schlüssel. */
export function open(sealed: string, env?: NodeJS.ProcessEnv): string {
  const [v, nonce, tag, data] = sealed.split(".");
  if (v !== "v1" || !nonce || !tag || !data) throw new Error("Ungültiges Format");
  const d = createDecipheriv("aes-256-gcm", key(env), Buffer.from(nonce, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
