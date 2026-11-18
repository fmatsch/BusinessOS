import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { verifySecondFactor } from "./mfa";
import { clearKey, isLimited, recordHit } from "./rate-limit";
import { auditUser } from "./user-audit";

const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200), code: z.string().max(40).optional() });

// Fester Hash, damit die Antwortzeit bei unbekannten Benutzern nicht verrät, ob ein Konto existiert.
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

/** Passwort stimmt, aber das Konto verlangt einen zweiten Faktor, der fehlt. Erst nach richtigem Passwort gemeldet. */
export class MfaRequiredError extends CredentialsSignin {
  code = "mfa_required";
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const email = parsed.data.email.toLowerCase();
        // Nur Fehlversuche zählen: 5 pro 15 Minuten und Konto (Passwort und Code); ein erfolgreicher Login setzt den Zähler zurück
        const key = `login:${email}`;
        if (isLimited(key, 5, 15 * 60_000)) return null;

        const user = await db.user.findUnique({ where: { email }, include: { mfa: { select: { enabledAt: true } } } });
        const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? DUMMY_HASH);
        if (!user || !user.active || !ok) {
          recordHit(key);
          return null;
        }
        if (user.mfa?.enabledAt) {
          const code = parsed.data.code?.trim();
          if (!code) throw new MfaRequiredError();
          if (!(await verifySecondFactor(user.id, code))) {
            recordHit(key);
            await auditUser(user.id, "auth.login.mfa_failed");
            return null;
          }
        }
        clearKey(key);
        return { id: user.id, email: user.email, name: user.name, sv: user.sessionVersion } as { id: string; email: string; name: string; sv: number };
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        token.sv = (user as { sv?: number }).sv ?? 0; // Sitzungsversion: Passwortwechsel und Zurücksetzen entwerten ältere Sitzungen
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      (session.user as { sv?: number }).sv = typeof token.sv === "number" ? token.sv : 0;
      return session;
    },
  },
});
