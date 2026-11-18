/**
 * E-Mail-Versand über SMTP (Umgebungsvariable `SMTP_URL`, z. B. `smtps://user:pass@mail.example:465`, Absender `MAIL_FROM`).
 * Ohne Konfiguration wird nichts versendet (`sendMail` gibt `false` zurück) – Funktionen, die auf E-Mail angewiesen sind, bieten dann einen anderen Weg an.
 */

export const isMailConfigured = (env: NodeJS.ProcessEnv = process.env) => !!env.SMTP_URL?.trim() && !!env.MAIL_FROM?.trim();

export interface Mail { to: string; subject: string; text: string }

/** Versendet eine Textmail. Gibt `true` bei Erfolg zurück; Fehler werden protokolliert (ohne Inhalt) und als `false` gemeldet. */
export async function sendMail(mail: Mail, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!isMailConfigured(env)) return false;
  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport(env.SMTP_URL!);
    await transport.sendMail({ from: env.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
    return true;
  } catch (e) {
    console.error("Mailversand fehlgeschlagen:", e instanceof Error ? e.message : "unbekannt");
    return false;
  }
}
