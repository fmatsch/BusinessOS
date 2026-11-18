import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { listApiTokens } from "@/platform/api/tokens";
import { revokeTokenAction } from "./actions";
import { TokenForm } from "./token-form";

export const dynamic = "force-dynamic";

export default async function ApiSettingsPage() {
  const ctx = await requireContext();
  if (!can(ctx, "api.token.manage")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const tokens = await listApiTokens(ctx);
  const now = Date.now();
  const state = (t: (typeof tokens)[number]) => (t.revokedAt ? "widerrufen" : t.expiresAt && t.expiresAt.getTime() <= now ? "abgelaufen" : "aktiv");

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API-Zugänge</h1>
        <p className="text-sm text-muted">Lesende REST-API für Anbindungen (Kunden, Artikel mit Bestand, Aufträge, Ausgangsrechnungen, E-Rechnung). Ein Token handelt als Sie in dieser Organisation und darf nur lesen, was Ihre Rolle lesen darf; Rollenentzug wirkt sofort. Bitte pro Anbindung ein eigenes Token anlegen und bei Verdacht sofort widerrufen. Beschreibung: <a className="text-accent underline" href="/api/v1/openapi.json">/api/v1/openapi.json</a>. Anfragen: <code>Authorization: Bearer bos_…</code>, 120 je Minute.</p>
      </div>
      <TokenForm />
      {tokens.length === 0 ? <p className="text-sm text-muted">Noch keine Tokens.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">API-Tokens</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Name</th><th scope="col">Beginnt mit</th><th scope="col">Gültig bis</th><th scope="col">Zuletzt genutzt</th><th scope="col">Status</th><th /></tr></thead>
          <tbody className="divide-y divide-line">
            {tokens.map((t) => (
              <tr key={t.id}><td className="py-1.5">{t.name}</td><td><code>{t.prefix}…</code></td><td>{t.expiresAt ? t.expiresAt.toISOString().slice(0, 10) : "–"}</td><td>{t.lastUsedAt ? t.lastUsedAt.toISOString().slice(0, 16).replace("T", " ") : "nie"}</td><td>{state(t)}</td>
                <td>{state(t) === "aktiv" && <form action={revokeTokenAction}><input type="hidden" name="id" value={t.id} /><button className="rounded-md border border-line px-2 py-0.5">Widerrufen</button></form>}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
