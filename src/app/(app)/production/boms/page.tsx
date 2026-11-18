import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createBom, listBoms } from "@/modules/production/service";
import { listItems } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/production/boms";
const LINES = 6;
const STATUS: Record<string, string> = { DRAFT: "Entwurf", ACTIVE: "aktiv", ARCHIVED: "archiviert" };
const num = (v: FormDataEntryValue | null) => String(v ?? "").replace(",", ".");

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const lines = Array.from({ length: LINES }, (_, i) => ({ componentItemId: String(fd.get(`comp${i}`) ?? ""), quantity: num(fd.get(`qty${i}`)), scrapPercent: num(fd.get(`scrap${i}`)) || "0" })).filter((l) => l.componentItemId !== "");
  const b = await runAction(BACK, () => createBom(ctx, { itemId: fd.get("itemId"), outputQuantity: num(fd.get("outputQuantity")) || "1", note: fd.get("note"), lines }));
  redirect(`/production/boms/${b.id}`);
}

export default async function BomsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let boms;
  try { boms = await listBoms(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "production.bom.manage");
  const items = manage ? (await listItems(ctx)).filter((i) => i.active) : [];
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/production">← Fertigung</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Stücklisten</h1>
        <p className="text-sm text-muted">Je Artikel mehrere Versionen; höchstens eine ist aktiv. Aktive Stücklisten sind gesperrt – Änderungen erfolgen als neue Version. Mehrstufig: eine Komponente kann selbst eine Stückliste haben (Zyklen werden abgewiesen).</p>
      </div>
      <ErrorBanner message={error} />
      {manage && (
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Stückliste anlegen">
          <h2 className="font-medium">Stückliste anlegen (Entwurf)</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="sm:col-span-2">Endprodukt<select name="itemId" required className={input}><option value="">–</option>{items.map((i) => <option key={i.id} value={i.id}>{i.number} {i.name}</option>)}</select></label>
            <label>Basismenge<input name="outputQuantity" defaultValue="1" inputMode="decimal" className={input} /></label>
            <label>Notiz<input name="note" maxLength={500} className={input} /></label>
          </div>
          {Array.from({ length: LINES }, (_, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-4">
              <label className="sm:col-span-2">Komponente {i + 1}<select name={`comp${i}`} className={input}><option value="">–</option>{items.map((x) => <option key={x.id} value={x.id}>{x.number} {x.name}</option>)}</select></label>
              <label>Menge {i + 1}<input name={`qty${i}`} inputMode="decimal" className={input} /></label>
              <label>Ausschuss % {i + 1}<input name={`scrap${i}`} inputMode="decimal" placeholder="0" className={input} /></label>
            </div>
          ))}
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button>
        </form>
      )}
      {boms.length === 0 ? <p className="text-sm text-muted">Noch keine Stücklisten.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Stücklisten</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Artikel</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col" className="text-right">Komponenten</th></tr></thead>
          <tbody className="divide-y divide-line">
            {boms.map((b) => (
              <tr key={b.id}><td className="py-1.5"><Link className="text-accent underline" href={`/production/boms/${b.id}`}>{b.item.number} {b.item.name}</Link></td><td>{b.version}</td><td>{STATUS[b.status]}</td><td className="text-right">{b._count.lines}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
