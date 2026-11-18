import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/platform/auth/auth";

async function login(formData: FormData) {
  "use server";
  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/",
    });
  } catch (e) {
    if (e instanceof AuthError) redirect("/login?error=1");
    throw e; // Redirect-Signal von Next.js weiterreichen
  }
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">BusinessOS</h1>
        <p className="text-sm text-muted">Anmelden / Sign in</p>
      </div>
      <form action={login} className="flex flex-col gap-3">
        <label className="text-sm">
          E-Mail
          <input name="email" type="email" required autoComplete="username"
            className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2" />
        </label>
        <label className="text-sm">
          Passwort / Password
          <input name="password" type="password" required autoComplete="current-password"
            className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2" />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">Anmeldung fehlgeschlagen.</p>}
        <button className="rounded-lg bg-accent px-3 py-2 font-medium text-white">Anmelden</button>
      </form>
    </main>
  );
}
