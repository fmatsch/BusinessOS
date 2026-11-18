import { randomBytes, randomInt } from "node:crypto";

export const randomHex = (bytes = 24) => randomBytes(bytes).toString("hex");
export const randomB64Url = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Zufallspasswort aus gut lesbaren Zeichen (ohne Verwechslungsgefahr), mindestens je eine Klasse. */
export function randomPassword(length = 20) {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnpqrstuvwxyz", "23456789", "-_.+="];
  const all = sets.join("");
  const chars = sets.map((s) => s[randomInt(s.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}
