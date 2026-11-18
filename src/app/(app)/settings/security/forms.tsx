"use client";

import { useActionState } from "react";
import { adminLinkAction, confirmSetupAction, regenerateCodesAction, type CodesState, type LinkState } from "./actions";

const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

function Codes({ codes }: { codes: string[] }) {
  return (
    <div role="status" className="space-y-1 rounded-xl border border-line bg-surface p-4 text-sm">
      <p className="font-medium">Wiederherstellungscodes – jeder gilt einmal und wird nur jetzt angezeigt. Bitte sicher aufbewahren (z. B. im Passwortmanager):</p>
      <ul className="grid grid-cols-2 gap-1 font-mono">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
    </div>
  );
}

export function ConfirmSetupForm() {
  const [state, action, pending] = useActionState<CodesState, FormData>(confirmSetupAction, {});
  if (state.recoveryCodes) return <Codes codes={state.recoveryCodes} />;
  return (
    <form action={action} className="space-y-2 text-sm" aria-label="Einrichtung bestätigen">
      <label>Code aus der App<input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={10} className={input + " max-w-40"} /></label>
      {state.error && <p role="alert" className="text-red-700 dark:text-red-400">{state.error}</p>}
      <button disabled={pending} className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Bestätigen und aktivieren</button>
    </form>
  );
}

export function RegenerateForm() {
  const [state, action, pending] = useActionState<CodesState, FormData>(regenerateCodesAction, {});
  return (
    <div className="space-y-2">
      <form action={action} className="flex flex-wrap items-end gap-3 text-sm" aria-label="Neue Wiederherstellungscodes">
        <label>Code aus der App<input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={20} className={input + " w-40"} /></label>
        <button disabled={pending} className="rounded-md border border-line px-3 py-1.5">Neue Wiederherstellungscodes erzeugen</button>
      </form>
      {state.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{state.error}</p>}
      {state.recoveryCodes && <Codes codes={state.recoveryCodes} />}
    </div>
  );
}

export function ResetLinkForm({ userId, label }: { userId: string; label: string }) {
  const [state, action, pending] = useActionState<LinkState, FormData>(adminLinkAction, {});
  return (
    <form action={action} className="space-y-1">
      <input type="hidden" name="userId" value={userId} />
      <button disabled={pending} aria-label={`Passwort-Link für ${label} erzeugen`} className="rounded-md border border-line px-2 py-0.5">Passwort-Link</button>
      {state.error && <p role="alert" className="text-red-700 dark:text-red-400">{state.error}</p>}
      {state.url && <p role="status" className="break-all">Einmal-Link (bis {state.expiresAt} UTC) – nur jetzt sichtbar, bitte über einen sicheren Weg weitergeben: <code>{state.url}</code></p>}
    </form>
  );
}
