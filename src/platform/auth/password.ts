import bcrypt from "bcryptjs";

/** Passwortregeln (rein) und Hash. Länge vor Komplexität: mindestens 12 Zeichen, keine offensichtlichen Passwörter. */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

const COMMON = new Set([
  "passwort1234", "password1234", "123456789012", "qwertzuiop12", "qwertyuiop12", "willkommen123", "welcome12345", "changeme1234", "administrator", "businessos123", "passwordpassword", "passwortpasswort",
]);

/** Fehlertext oder `null`, wenn das Passwort zulässig ist. */
export function passwordProblem(password: string, context: { email?: string; name?: string } = {}): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Das Passwort darf höchstens ${MAX_PASSWORD_LENGTH} Zeichen lang sein`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "Dieses Passwort ist zu verbreitet";
  if (/^(.)\1+$/.test(password)) return "Das Passwort darf nicht aus einem einzigen Zeichen bestehen";
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (context.email && lower.includes(context.email.toLowerCase())) return "Das Passwort darf nicht die E-Mail-Adresse enthalten";
  if (local && local.length >= 4 && lower.includes(local)) return "Das Passwort darf nicht den Namen aus der E-Mail-Adresse enthalten";
  if (context.name && context.name.trim().length >= 4 && lower.includes(context.name.trim().toLowerCase())) return "Das Passwort darf nicht Ihren Namen enthalten";
  return null;
}

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
