import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { getMfaStatus, listMfaStatus, pendingMfaSetup } from "@/platform/auth/mfa";
import { ErrorBanner } from "../../action-helpers";
import { adminResetMfaAction, beginSetupAction, changePasswordAction, disableAction } from "./actions";
import { ConfirmSetupForm, RegenerateForm, ResetLinkForm } from "./forms";

export const dynamic = "force-dynamic";
const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  const status = await getMfaStatus(ctx.userId);
  const pending = status.pending ? await pendingMfaSetup(ctx.userId) : null;
  const members = can(ctx, "org.members.manage") ? await listMfaStatus(ctx) : [];

  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sicherheit</h1>
        <p className="text-sm text-muted">Zwei-Faktor-Anmeldung mit einer Authenticator-App (TOTP) und Passwort. Die Einstellungen gelten für Ihr Konto in allen Organisationen.</p>
      </div>
      <ErrorBanner message={error} />

      <section className="space-y-3" aria-label="Zwei-Faktor-Anmeldung">
        <h2 className="font-medium">Zwei-Faktor-Anmeldung: {status.enabled ? "aktiv" : "nicht eingerichtet"}</h2>
        {!status.enabled && !pending && (
          <form action={beginSetupAction}><button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg">Einrichten</button></form>
        )}
        {pending && (
          <div className="space-y-3 text-sm">
            <p>1. Öffnen Sie Ihre Authenticator-App und fügen Sie ein Konto hinzu: „Schlüssel manuell eingeben“ bzw. den Link unten öffnen.</p>
            <p>Geheimer Schlüssel: <code className="break-all rounded bg-surface px-2 py-1">{pending.secret.replace(/(.{4})/g, "$1 ").trim()}</code></p>
            <p className="break-all text-muted">Link für Apps, die ihn öffnen können: <a className="underline" href={pending.uri}>{pending.uri}</a></p>
            <p>2. Geben Sie den aktuellen 6-stelligen Code der App ein:</p>
            <ConfirmSetupForm />
          </div>
        )}
        {status.enabled && (
          <div className="space-y-4 text-sm">
            <p>Noch {status.recoveryLeft} Wiederherstellungscodes übrig.</p>
            <RegenerateForm />
            <form action={disableAction} className="flex flex-wrap items-end gap-3" aria-label="Zwei-Faktor-Anmeldung deaktivieren">
              <label>Passwort<input name="password" type="password" required autoComplete="current-password" className={input + " w-48"} /></label>
              <label>Code<input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={20} className={input + " w-40"} /></label>
              <button className="rounded-md border border-line px-3 py-1.5">Deaktivieren</button>
            </form>
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="Passwort ändern">
        <h2 className="font-medium">Passwort ändern</h2>
        <form action={changePasswordAction} className="grid gap-3 text-sm sm:grid-cols-3">
          <label>Aktuelles Passwort<input name="current" type="password" required autoComplete="current-password" className={input} /></label>
          <label>Neues Passwort (mind. 12 Zeichen)<input name="next" type="password" required minLength={12} autoComplete="new-password" className={input} /></label>
          <label>Wiederholen<input name="next2" type="password" required minLength={12} autoComplete="new-password" className={input} /></label>
          <div className="sm:col-span-3"><button className="rounded-md border border-line px-3 py-1.5">Passwort ändern</button> <span className="text-muted">Danach melden Sie sich neu an (alle Sitzungen enden).</span></div>
        </form>
      </section>

      {members.length > 0 && (
        <section className="space-y-3" aria-label="Mitglieder">
          <h2 className="font-medium">Mitglieder</h2>
          <p className="text-sm text-muted">Gerät verloren oder Passwort vergessen: Zwei-Faktor zurücksetzen bzw. einen Einmal-Link erzeugen. Nur für Konten, die ausschließlich zu dieser Organisation gehören; Sitzungen enden dabei.</p>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Mitglieder und Zwei-Faktor-Stand</caption>
            <thead className="text-muted"><tr><th scope="col" className="py-2">Name</th><th scope="col">Rolle</th><th scope="col">Zwei-Faktor</th><th scope="col">Aktionen</th></tr></thead>
            <tbody className="divide-y divide-line">
              {members.map((m) => (
                <tr key={m.userId} className="align-top">
                  <td className="py-1.5">{m.name}<br /><span className="text-muted">{m.email}{m.active ? "" : " (inaktiv)"}</span></td>
                  <td>{m.role}</td><td>{m.mfaEnabled ? "aktiv" : "aus"}</td>
                  <td>
                    {m.userId !== ctx.userId && (
                      <div className="space-y-1">
                        {m.mfaEnabled && <form action={adminResetMfaAction}><input type="hidden" name="userId" value={m.userId} /><button aria-label={`Zwei-Faktor für ${m.name} zurücksetzen`} className="rounded-md border border-line px-2 py-0.5">Zwei-Faktor zurücksetzen</button></form>}
                        <ResetLinkForm userId={m.userId} label={m.name} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
