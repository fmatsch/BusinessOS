import Link from "next/link";
import { redirect } from "next/navigation";
import { ConflictError } from "@/platform/errors";
import { completePasswordReset, peekResetToken } from "@/platform/auth/password-reset";

export const dynamic = "force-dynamic";

async function reset(fd: FormData) {
  "use server";
  const token = String(fd.get("token") ?? "");
  const a = String(fd.get("password") ?? ""), b = String(fd.get("password2") ?? "");
  if (a !== b) redirect(`/reset/${token}?error=${encodeURIComponent("Die beiden Passwörter stimmen nicht überein")}`);
  try {
    await completePasswordReset(token, a);
  } catch (e) {
    if (e instanceof ConflictError) redirect(`/reset/${token}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect("/login?reset=1");
}

export default async function ResetPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ token }, { error }] = await Promise.all([params, searchParams]);
  const valid = await peekResetToken(token);
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Neues Passwort</h1>
        {valid && <p className="text-sm text-muted">Konto {valid.email}</p>}
      </div>
      {!valid ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">Der Link ist ungültig oder abgelaufen. Bitte fordern Sie einen neuen an.</p>
      ) : (
        <form action={reset} className="flex flex-col gap-3">
          <input type="hidden" name="token" value={token} />
          <label className="text-sm">Neues Passwort (mindestens 12 Zeichen)<input name="password" type="password" required minLength={12} autoComplete="new-password" className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2" /></label>
          <label className="text-sm">Wiederholen<input name="password2" type="password" required minLength={12} autoComplete="new-password" className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2" /></label>
          {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
          <button className="rounded-lg bg-accent px-3 py-2 font-medium text-accent-fg">Passwort speichern</button>
        </form>
      )}
      <p className="text-sm"><Link className="text-accent underline" href="/forgot">Neuen Link anfordern</Link> · <Link className="text-accent underline" href="/login">Anmeldung</Link></p>
    </main>
  );
}
