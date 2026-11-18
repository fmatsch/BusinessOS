import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { activateBom, deleteBomDraft, getBom } from "@/modules/production/service";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";
const STATUS: Record<string, string> = { DRAFT: "Entwurf", ACTIVE: "aktiv", ARCHIVED: "archiviert" };

async function activate(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/production/boms/${id}`, () => activateBom(ctx, id)); revalidatePath(`/production/boms/${id}`); }
async function remove(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/production/boms/${id}`, () => deleteBomDraft(ctx, id)); redirect("/production/boms"); }

export default async function BomPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; qty?: string }> }) {
  const [{ id }, { error, qty }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let bom, problem = "";
  try { bom = await getBom(ctx, id, qty || undefined); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    if (!(e instanceof ConflictError)) throw e;
    problem = e.message;
    bom = await getBom(ctx, id);
  }
  const manage = can(ctx, "production.bom.manage");
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/production/boms">← Stücklisten</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">{bom.item.number} {bom.item.name} · Version {bom.version} · {STATUS[bom.status]}</h1>
        <p className="text-sm text-muted">Die Zeilen gelten für {bom.outputQuantity.toString()} {bom.item.unit} Endprodukt.{bom.note ? ` ${bom.note}` : ""}</p>
      </div>
      <ErrorBanner message={error ?? (problem || undefined)} />
      {manage && bom.status === "DRAFT" && (
        <div className="flex gap-3 text-sm">
          <form action={activate}><input type="hidden" name="id" value={bom.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Aktivieren</button></form>
          <form action={remove}><input type="hidden" name="id" value={bom.id} /><button className="rounded-md border border-line px-3 py-1.5">Entwurf löschen</button></form>
        </div>
      )}
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Komponenten</caption>
        <thead className="text-muted"><tr><th scope="col" className="py-2">Komponente</th><th scope="col" className="text-right">Menge</th><th scope="col" className="text-right">Ausschuss %</th></tr></thead>
        <tbody className="divide-y divide-line">
          {bom.lines.map((l) => <tr key={l.id}><td className="py-1.5">{l.component.number} {l.component.name}</td><td className="text-right">{l.quantity.toString()} {l.component.unit}</td><td className="text-right">{l.scrapPercent.toString()}</td></tr>)}
        </tbody>
      </table>
      <section aria-label="Mehrstufige Auflösung" className="space-y-2">
        <h2 className="font-medium">Auflösung für eine Menge</h2>
        <form method="get" className="flex items-end gap-3 text-sm">
          <label>Menge<input name="qty" defaultValue={bom.explodeQuantity.toString()} inputMode="decimal" className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
          <button className="rounded-md border border-line px-3 py-1.5">Berechnen</button>
        </form>
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Gesamtbedarf</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Artikel</th><th scope="col">Stufe</th><th scope="col">Art</th><th scope="col" className="text-right">Bedarf</th></tr></thead>
          <tbody className="divide-y divide-line">
            {bom.exploded.map((e) => <tr key={e.itemId}><td className="py-1.5">{e.item.number} {e.item.name}</td><td>{e.level}</td><td>{e.leaf ? "Rohstoff/Kaufteil" : "Baugruppe"}</td><td className="text-right">{e.quantity.toString()} {e.item.unit}</td></tr>)}
          </tbody>
        </table>
      </section>
    </div>
  );
}
