import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isMailConfigured, requestPasswordReset } from "@/platform/auth/password-reset";

export const dynamic = "force-dynamic";

async function request(fd: FormData) {
  "use server";
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  await requestPasswordReset(String(fd.get("email") ?? ""), process.env.APP_URL?.replace(/\/$/, "") ?? `${proto}://${host}`);
  redirect("/forgot?sent=1");
}

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  const mail = isMailConfigured();
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Passwort vergessen</h1>
        <p className="text-sm text-muted">Wir senden einen Link zum Festlegen eines neuen Passworts.</p>
      </div>
      {!mail && <p role="status" className="text-sm">Der E-Mail-Versand ist auf diesem Server nicht eingerichtet. Bitte wenden Sie sich an die Inhaberin oder den Inhaber Ihrer Organisation – sie können Ihnen einen Link erzeugen.</p>}
      {sent ? (
        <p role="status" className="text-sm">Falls zu dieser Adresse ein Konto existiert, haben wir eine E-Mail mit dem Link gesendet. Der Link gilt 60 Minuten.</p>
      ) : mail && (
        <form action={request} className="flex flex-col gap-3">
          <label className="text-sm">E-Mail<input name="email" type="email" required autoComplete="username" className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2" /></label>
          <button className="rounded-lg bg-accent px-3 py-2 font-medium text-accent-fg">Link senden</button>
        </form>
      )}
      <p className="text-sm"><Link className="text-accent underline" href="/login">Zur Anmeldung</Link></p>
    </main>
  );
}
