import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { PERMISSIONS } from "@/platform/authz/permissions";
import { listWorkflowRuns, listWorkflows, publishWorkflow, setWorkflowEnabled, workflowHistory } from "@/modules/workflows/service";
import { EVENT_CATALOG } from "@/modules/workflows/catalog";
import { OP_LABEL, OPS, MAX_ACTIONS, MAX_CONDITIONS, type Action, type Condition } from "@/modules/workflows/engine";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/workflows";

async function publish(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const conditions = Array.from({ length: MAX_CONDITIONS }, (_, i) => ({ field: String(fd.get(`cf${i}`) ?? ""), op: String(fd.get(`co${i}`) ?? ""), value: String(fd.get(`cv${i}`) ?? "").trim() })).filter((c) => c.field !== "" && c.value !== "");
  const actions = Array.from({ length: MAX_ACTIONS }, (_, i) => {
    const kind = String(fd.get(`ar${i}`) ?? "");
    const title = String(fd.get(`at${i}`) ?? "").trim();
    if (!kind || !title) return null;
    return { type: "NOTIFY", recipient: kind === "ACTOR" ? { kind: "ACTOR" } : { kind: "PERMISSION", permission: String(fd.get(`ap${i}`) ?? "") }, title, body: String(fd.get(`ab${i}`) ?? "").trim() || undefined };
  }).filter(Boolean);
  const key = String(fd.get("key") ?? "");
  await runAction(`${BACK}?key=${encodeURIComponent(key)}`, () => publishWorkflow(ctx, { key, name: fd.get("name"), eventType: fd.get("eventType"), conditions, actions, enabled: fd.get("enabled") === "on" }));
  revalidatePath(BACK);
  redirect(BACK);
}
async function toggle(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setWorkflowEnabled(ctx, String(fd.get("key")), fd.get("enabled") === "true")); revalidatePath(BACK); }

const describeCondition = (c: Condition) => `${c.field} ${OP_LABEL[c.op]} ${c.value}`;
const describeAction = (a: Action) => `${a.recipient.kind === "ACTOR" ? "auslösende Person" : `Inhaber der Berechtigung ${a.recipient.permission}`}: „${a.title}“`;

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ error?: string; key?: string }> }) {
  const { error, key } = await searchParams;
  const ctx = await requireContext();
  let list, runs;
  try { [list, runs] = await Promise.all([listWorkflows(ctx), listWorkflowRuns(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "workflow.manage");
  const edit = key ? list.find((w) => w.key === key) ?? null : null;
  const history = edit ? await workflowHistory(ctx, edit.key) : [];
  const nCond = Math.min(MAX_CONDITIONS, Math.max(3, (edit?.conditions.length ?? 0) + 1));
  const nAct = Math.min(MAX_ACTIONS, Math.max(1, (edit?.actions.length ?? 0) + 1));
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const events = Object.entries(EVENT_CATALOG);

  return (
    <div className="max-w-6xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
        <p className="text-sm text-muted">Regeln der Form „Wenn ein Ereignis eintritt und die Bedingungen zutreffen, benachrichtige …“. Jede Änderung ist eine neue, nachvollziehbare Version; frühere Versionen bleiben erhalten. Workflows senden ausschließlich Benachrichtigungen in der Anwendung – sie ändern keine Daten und rufen nichts außerhalb auf.</p>
      </div>
      <ErrorBanner message={error} />

      {manage && (
        <form key={edit?.key ?? "neu"} action={publish} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Workflow veröffentlichen">
          <h2 className="font-medium">{edit ? `Neue Version von „${edit.name}“` : "Neuen Workflow anlegen"}</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label>Schlüssel<input name="key" required defaultValue={edit?.key ?? ""} readOnly={!!edit} pattern="[a-z0-9][a-z0-9-]{1,38}" className={input} placeholder="grosse-rechnung" /></label>
            <label className="sm:col-span-2">Name<input name="name" required maxLength={100} defaultValue={edit?.name ?? ""} className={input} /></label>
            <label className="flex items-end gap-2"><input type="checkbox" name="enabled" defaultChecked={edit?.enabled ?? true} /> aktiv</label>
            <label className="sm:col-span-4">Ereignis
              <select name="eventType" required defaultValue={edit?.eventType ?? ""} className={input}><option value="">–</option>{events.map(([k, e]) => <option key={k} value={k}>{e.label}</option>)}</select></label>
          </div>
          <fieldset className="space-y-2"><legend className="font-medium">Bedingungen (alle müssen zutreffen; ohne Angabe immer)</legend>
            {Array.from({ length: nCond }, (_, i) => {
              const c = edit?.conditions[i];
              return (
                <div key={i} className="grid gap-2 sm:grid-cols-3">
                  <select name={`cf${i}`} aria-label={`Feld ${i + 1}`} defaultValue={c?.field ?? ""} className={input}><option value="">Feld …</option>{events.filter(([, e]) => Object.keys(e.fields).length > 0).map(([k, e]) => <optgroup key={k} label={e.label}>{Object.entries(e.fields).map(([f, s]) => <option key={`${k}.${f}`} value={f}>{s.label} ({f})</option>)}</optgroup>)}</select>
                  <select name={`co${i}`} aria-label={`Vergleich ${i + 1}`} defaultValue={c?.op ?? "gt"} className={input}>{OPS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}</select>
                  <input name={`cv${i}`} aria-label={`Wert ${i + 1}`} defaultValue={c?.value ?? ""} maxLength={100} className={input} placeholder="Wert" />
                </div>
              );
            })}
          </fieldset>
          <fieldset className="space-y-3"><legend className="font-medium">Aktionen (Benachrichtigung)</legend>
            {Array.from({ length: nAct }, (_, i) => {
              const a = edit?.actions[i];
              return (
                <div key={i} className="grid gap-2 sm:grid-cols-4">
                  <select name={`ar${i}`} aria-label={`Empfänger ${i + 1}`} defaultValue={a ? a.recipient.kind : ""} className={input}><option value="">Empfänger …</option><option value="PERMISSION">Personen mit Berechtigung</option><option value="ACTOR">Auslösende Person</option></select>
                  <select name={`ap${i}`} aria-label={`Berechtigung ${i + 1}`} defaultValue={a && a.recipient.kind === "PERMISSION" ? a.recipient.permission : ""} className={input}><option value="">Berechtigung …</option>{PERMISSIONS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
                  <input name={`at${i}`} aria-label={`Titel ${i + 1}`} defaultValue={a?.title ?? ""} maxLength={160} className={input} placeholder="Titel, z. B. Rechnung {{number}}" />
                  <input name={`ab${i}`} aria-label={`Text ${i + 1}`} defaultValue={a?.body ?? ""} maxLength={400} className={input} placeholder="Text (optional)" />
                </div>
              );
            })}
            <p className="text-xs text-muted">Platzhalter in Titel und Text: <code>{"{{feld}}"}</code> mit den Feldern des Ereignisses (siehe Bedingungen). Andere Platzhalter bleiben leer.</p>
          </fieldset>
          <div className="flex gap-3"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">{edit ? "Als neue Version veröffentlichen" : "Veröffentlichen"}</button>{edit && <Link className="rounded-md border border-line px-3 py-1.5" href={BACK}>Abbrechen</Link>}</div>
          {edit && history.length > 1 && <p className="text-xs text-muted">Versionen: {history.map((h) => `v${h.version}${h.enabled ? "" : " (aus)"}`).join(" · ")}</p>}
        </form>
      )}

      {list.length === 0 ? <p className="text-sm text-muted">Noch keine Workflows.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Name</th><th>Ereignis</th><th>Bedingungen</th><th>Aktionen</th><th>Version</th><th>Status</th>{manage && <th />}</tr></thead>
          <tbody className="divide-y divide-line align-top">
            {list.map((w) => (
              <tr key={w.key}>
                <td className="py-2">{w.name}<div className="text-xs text-muted">{w.key}</div></td><td>{EVENT_CATALOG[w.eventType]?.label ?? w.eventType}</td>
                <td>{w.conditions.length === 0 ? "immer" : w.conditions.map((c, i) => <div key={i}>{describeCondition(c)}</div>)}</td>
                <td>{w.actions.map((a, i) => <div key={i}>{describeAction(a)}</div>)}</td><td>{w.version}</td><td>{w.enabled ? "aktiv" : "aus"}</td>
                {manage && (
                  <td className="space-y-1">
                    <Link className="block text-accent underline" href={`${BACK}?key=${w.key}`}>Bearbeiten</Link>
                    <form action={toggle}><input type="hidden" name="key" value={w.key} /><input type="hidden" name="enabled" value={String(!w.enabled)} /><button className="rounded-md border border-line px-2 py-0.5">{w.enabled ? "Ausschalten" : "Einschalten"}</button></form>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="space-y-2" aria-label="Protokoll">
        <h2 className="font-medium">Protokoll (letzte 50 Auswertungen)</h2>
        {runs.length === 0 ? <p className="text-sm text-muted">Noch nichts ausgewertet.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Zeit</th><th>Workflow</th><th>Ereignis</th><th>Ergebnis</th></tr></thead>
            <tbody className="divide-y divide-line">
              {runs.map((r) => <tr key={r.id}><td className="py-2">{r.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td><td>{r.definition.name} (v{r.definition.version})</td><td>{EVENT_CATALOG[r.eventType]?.label ?? r.eventType}</td><td>{r.matched ? `ausgelöst, ${r.notifications} Benachrichtigung(en)` : "Bedingungen nicht erfüllt"}</td></tr>)}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
