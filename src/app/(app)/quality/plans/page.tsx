import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { activateInspectionPlan, createInspectionPlan, deleteInspectionPlanDraft, listInspectionPlans } from "@/modules/quality/service";
import { listItems } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/quality/plans";
const ROWS = 5;
const STATUS: Record<string, string> = { DRAFT: "Entwurf", ACTIVE: "aktiv", ARCHIVED: "archiviert" };
const num = (v: FormDataEntryValue | null) => String(v ?? "").replace(",", ".");

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const characteristics = Array.from({ length: ROWS }, (_, i) => ({ name: String(fd.get(`name${i}`) ?? "").trim(), kind: fd.get(`kind${i}`), unit: fd.get(`unit${i}`), minValue: num(fd.get(`min${i}`)), maxValue: num(fd.get(`max${i}`)) })).filter((c) => c.name !== "");
  await runAction(BACK, () => createInspectionPlan(ctx, { itemId: fd.get("itemId"), note: fd.get("note"), characteristics }));
  revalidatePath(BACK);
}
async function activate(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => activateInspectionPlan(ctx, String(fd.get("id")))); revalidatePath(BACK); }
async function remove(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => deleteInspectionPlanDraft(ctx, String(fd.get("id")))); revalidatePath(BACK); }

export default async function PlansPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let plans;
  try { plans = await listInspectionPlans(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "qm.plan.manage");
  const items = manage && can(ctx, "inventory.read") ? (await listItems(ctx)).filter((i) => i.active) : [];
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/quality">← Qualität</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Prüfpläne</h1>
        <p className="text-sm text-muted">Je Artikel mehrere Versionen, höchstens eine aktiv. Aktive Prüfpläne sind gesperrt – Änderungen erfolgen als neue Version. Messmerkmale brauchen mindestens eine Grenze (einschließlich).</p>
      </div>
      <ErrorBanner message={error} />
      {manage && (
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Prüfplan anlegen">
          <h2 className="font-medium">Prüfplan anlegen (Entwurf)</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <label>Artikel<select name="itemId" required className={input}><option value="">–</option>{items.map((i) => <option key={i.id} value={i.id}>{i.number} {i.name}</option>)}</select></label>
            <label className="sm:col-span-2">Notiz<input name="note" maxLength={500} className={input} /></label>
          </div>
          {Array.from({ length: ROWS }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-5">
              <label className="sm:col-span-2">Merkmal {i + 1}<input name={`name${i}`} maxLength={120} className={input} /></label>
              <label>Art {i + 1}<select name={`kind${i}`} className={input}><option value="QUANTITATIVE">Messwert</option><option value="QUALITATIVE">in Ordnung / nicht in Ordnung</option></select></label>
              <label>Min {i + 1}<input name={`min${i}`} inputMode="decimal" className={input} /></label>
              <label>Max {i + 1}<input name={`max${i}`} inputMode="decimal" className={input} /></label>
              <input type="hidden" name={`unit${i}`} value="" />
            </div>
          ))}
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button>
        </form>
      )}
      {plans.length === 0 ? <p className="text-sm text-muted">Noch keine Prüfpläne.</p> : plans.map((p) => (
        <div key={p.id} className="rounded-xl border border-line bg-surface p-4 text-sm">
          <p className="font-medium">{p.item.number} {p.item.name} · Version {p.version} · {STATUS[p.status]}</p>
          <ul className="mt-1 list-disc pl-5 text-muted">{p.characteristics.map((c) => <li key={c.id}>{c.name}: {c.kind === "QUALITATIVE" ? "in Ordnung" : `${c.minValue?.toString() ?? "–"} bis ${c.maxValue?.toString() ?? "–"}`}</li>)}</ul>
          {manage && p.status === "DRAFT" && (
            <div className="mt-2 flex gap-2">
              <form action={activate}><input type="hidden" name="id" value={p.id} /><button className="rounded-md bg-accent px-3 py-1 font-medium text-accent-fg">Aktivieren</button></form>
              <form action={remove}><input type="hidden" name="id" value={p.id} /><button className="rounded-md border border-line px-3 py-1">Entwurf löschen</button></form>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
