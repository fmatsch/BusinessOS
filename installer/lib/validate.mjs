// Eingabeprüfung für alles, was in Skripte, Konfigurationsdateien oder Befehle einfließt. Alles andere wird abgelehnt (Allowlist).

export const isPort = (v) => Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 65535 && /^\d+$/.test(String(v));

/** Hostname oder IP-Adresse (IPv4/IPv6) für die SSH-Verbindung. */
export function isHost(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return v.split(".").every((p) => Number(p) <= 255);
  if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(":")) return true;
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(v);
}

/** Öffentlicher Domainname für das Zertifikat (mindestens zwei Labels, Kleinbuchstaben). */
export const isDomain = (v) => typeof v === "string" && v.length <= 253 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v);

export const isEmail = (v) => typeof v === "string" && v.length <= 254 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v);

export const isUnixUser = (v) => typeof v === "string" && /^[a-z_][a-z0-9_-]{0,31}$/.test(v);

/** Freitext (Namen): keine Steuerzeichen, begrenzte Länge. */
export const isText = (v, max = 120) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

export const passwordProblem = (v) => {
  if (typeof v !== "string" || v.length < 12) return "Das Passwort braucht mindestens 12 Zeichen.";
  if (v.length > 128) return "Das Passwort ist zu lang (höchstens 128 Zeichen).";
  if (/[\u0000-\u001f\u007f]/.test(v)) return "Das Passwort enthält Steuerzeichen.";
  return null;
};

/** Einfaches Anführen für POSIX-Shell: '…' mit maskierten Hochkommas. Nur für Werte, die bereits als Text geprüft sind. */
export function shq(v) {
  const s = String(v);
  if (/[\u0000\n\r]/.test(s)) throw new Error("Wert enthält Zeilenumbruch oder NUL");
  return "'" + s.split("'").join("'\\''") + "'";
}

/** Node-Version ≥ 20.9 (Voraussetzung von Next.js). */
export function nodeOk(version = process.versions.node) {
  const [maj, min] = version.split(".").map(Number);
  return maj > 20 || (maj === 20 && min >= 9);
}
