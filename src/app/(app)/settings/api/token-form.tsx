"use client";

import { useActionState } from "react";
import { createTokenAction, type CreateState } from "./actions";

const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

export function TokenForm() {
  const [state, action, pending] = useActionState<CreateState, FormData>(createTokenAction, {});
  return (
    <div className="space-y-3">
      <form action={action} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3" aria-label="Token anlegen">
        <label>Name<input name="name" required maxLength={80} className={input} /></label>
        <label>Gültig (Tage)<input name="expiresInDays" type="number" min={1} max={730} defaultValue={90} className={input} /></label>
        <div className="self-end"><button disabled={pending} className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Token anlegen</button></div>
      </form>
      {state.error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{state.error}</p>}
      {state.token && (
        <div role="status" className="space-y-1 rounded-xl border border-line bg-surface p-4 text-sm">
          <p className="font-medium">Ihr neues Token – es wird nur jetzt angezeigt. Kopieren und sicher aufbewahren (gültig bis {state.expiresAt}):</p>
          <p><code className="break-all rounded bg-bg px-2 py-1">{state.token}</code></p>
        </div>
      )}
    </div>
  );
}
