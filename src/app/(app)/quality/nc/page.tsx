import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { closeNonConformance, createNonConformance, listNonConformances, updateNonConformance } from "@/modules/quality/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/quality/nc";

async function create(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createNonConformance(ctx, { description: fd.get("description"), cause: fd.get("cause"), action: fd.get("action") })); revalidatePath(BACK); }
async function update(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => updateNonConformance(ctx, String(fd.get("id")), { cause: fd.get("cause"), action: fd.get("action") })); revalidatePath(BACK); }
async function close(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  // zuerst die eingetragenen Texte speichern, dann schließen
  await runAction(BACK, async () => { await updateNonConformance(ctx, id, { cause: fd.get("cause"), action: fd.get("action") }); await closeNonConformance(ctx, id); });
  revalidatePath(BACK);
}

export default async function NcPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let ncs;
  try { ncs = await listNonConformances(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "qm.nc.manage");
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/quality">← Qualität</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Abweichungen</h1>
        <p className="text-sm text-muted">Abgelehnte Prüflose und Sonderfreigaben legen automatisch eine Abweichung an. Zum Schließen sind Ursache und Maßnahme Pflicht; geschlossene Abweichungen sind unveränderlich.</p>
      </div>
      <ErrorBanner message={error} />
      {manage && (
        <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3" aria-label="Abweichung anlegen">
          <h2 className="font-medium sm:col-span-3">Abweichung anlegen</h2>
          <label className="sm:col-span-3">Beschreibung<input name="description" required minLength={5} maxLength={1000} className={input} /></label>
          <label>Ursache<input name="cause" maxLength={1000} className={input} /></label>
          <label>Maßnahme<input name="action" maxLength={1000} className={input} /></label>
          <div className="self-end"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button></div>
        </form>
      )}
      {ncs.length === 0 ? <p className="text-sm text-muted">Keine Abweichungen.</p> : ncs.map((n) => (
        <div key={n.id} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <p className="font-medium">{n.number} · {n.status === "OPEN" ? "offen" : "geschlossen"}{n.item ? ` · ${n.item.number} ${n.item.name}` : ""}</p>
          <p>{n.description}</p>
          {manage && n.status === "OPEN" ? (
            <form action={update} className="grid gap-2 sm:grid-cols-3" aria-label={`Bearbeiten ${n.number}`}>
              <input type="hidden" name="id" value={n.id} />
              <label>Ursache<input name="cause" defaultValue={n.cause ?? ""} maxLength={1000} className={input} /></label>
              <label>Maßnahme<input name="action" defaultValue={n.action ?? ""} maxLength={1000} className={input} /></label>
              <div className="flex items-end gap-2">
                <button className="rounded-md border border-line px-3 py-1">Speichern</button>
                <button formAction={close} className="rounded-md border border-line px-3 py-1">Schließen</button>
              </div>
            </form>
          ) : <p className="text-muted">Ursache: {n.cause ?? "–"} · Maßnahme: {n.action ?? "–"}</p>}
        </div>
      ))}
    </div>
  );
}
