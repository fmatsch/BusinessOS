import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createAsset, disposeAsset, listAssets, runDepreciation } from "@/modules/gl/assets";
import { listAccounts } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/finance/ledger/assets";

async function create(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createAsset(ctx, { name: fd.get("name"), acquiredOn: fd.get("acquiredOn"), cost: String(fd.get("cost") ?? "").replace(",", "."), residualValue: String(fd.get("residualValue") || "0").replace(",", "."), usefulLifeMonths: fd.get("usefulLifeMonths"), assetAccountId: fd.get("assetAccountId"), depreciationAccountId: fd.get("depreciationAccountId") }));
  revalidatePath(BACK);
}
async function depreciate(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => runDepreciation(ctx, Number(fd.get("year")), Number(fd.get("month")))); revalidatePath(BACK); }
async function dispose(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => disposeAsset(ctx, String(fd.get("id")), String(fd.get("disposedOn")))); revalidatePath(BACK); }

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let assets, accounts;
  try { [assets, accounts] = await Promise.all([listAssets(ctx), listAccounts(ctx)]); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const poster = can(ctx, "gl.post");
  const gl = accounts.filter((a) => a.type === "GL" && a.active);
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const today = now.toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/finance/ledger">← Hauptbuch</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Anlagenbuchhaltung</h1>
        <p className="text-sm text-muted">Anlagenverzeichnis mit linearer Monatsabschreibung (ab dem Anschaffungsmonat, ohne Halbjahresregel). Die Anschaffung buchen Sie über die Rechnung mit dem Anlagenkonto; die Abschreibung bucht „AfA buchen“ gegen das Anlagenkonto. Ausscheiden stoppt nur die Abschreibung – Restbuchwert und Erlös buchen Sie manuell.</p>
      </div>
      <ErrorBanner message={error} />
      {poster && (
        <div className="grid gap-4 lg:grid-cols-2">
          <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-2" aria-label="Anlagegut anlegen">
            <h2 className="font-medium sm:col-span-2">Anlagegut anlegen</h2>
            <label className="sm:col-span-2">Bezeichnung<input name="name" required maxLength={120} className={input} /></label>
            <label>Anschaffung am<input type="date" name="acquiredOn" required className={input} /></label>
            <label>Anschaffungskosten (netto)<input name="cost" required inputMode="decimal" className={input} /></label>
            <label>Restwert<input name="residualValue" inputMode="decimal" placeholder="0" className={input} /></label>
            <label>Nutzungsdauer (Monate)<input name="usefulLifeMonths" type="number" min={1} max={600} required className={input} /></label>
            <label>Anlagenkonto<select name="assetAccountId" required className={input}><option value="">–</option>{gl.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>
            <label>AfA-Aufwandskonto<select name="depreciationAccountId" required className={input}><option value="">–</option>{gl.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}</select></label>
            <div className="sm:col-span-2"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button></div>
          </form>
          <form action={depreciate} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm" aria-label="Abschreibung buchen">
            <h2 className="w-full font-medium">AfA buchen</h2>
            <label>Jahr<input name="year" type="number" defaultValue={prev.getUTCFullYear()} className={input + " w-24"} /></label>
            <label>Monat<input name="month" type="number" min={1} max={12} defaultValue={prev.getUTCMonth() + 1} className={input + " w-20"} /></label>
            <button className="rounded-md border border-line px-3 py-1.5">Abschreibung buchen</button>
            <p className="w-full text-xs text-muted">Bucht für alle aktiven Anlagegüter die Monatsabschreibung (je Monat einmal). Nur abgelaufene Monate.</p>
          </form>
        </div>
      )}
      {assets.length === 0 ? <p className="text-sm text-muted">Noch keine Anlagegüter.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Anlagenverzeichnis</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Nr.</th><th scope="col">Bezeichnung</th><th scope="col">Anschaffung</th><th scope="col" className="text-right">Kosten</th><th scope="col" className="text-right">Gebuchte AfA</th><th scope="col" className="text-right">Buchwert (gebucht)</th><th scope="col" className="text-right">Buchwert (rechnerisch heute)</th><th scope="col">Status</th>{poster && <th />}</tr></thead>
          <tbody className="divide-y divide-line">
            {assets.map((a) => (
              <tr key={a.id}>
                <td className="py-1.5">{a.number}</td><td>{a.name}</td><td>{a.acquiredOn.toISOString().slice(0, 10)}</td>
                <td className="text-right">{formatMoney(a.cost.toString())}</td><td className="text-right">{formatMoney(a.bookedDepreciation.toString())}</td>
                <td className="text-right">{formatMoney(a.bookedBookValue.toString())}</td><td className="text-right">{formatMoney(a.bookValue.toString())}</td>
                <td>{a.status === "ACTIVE" ? "aktiv" : `ausgeschieden ${a.disposedOn?.toISOString().slice(0, 10)}`}</td>
                {poster && <td>{a.status === "ACTIVE" && <form action={dispose} className="flex items-center gap-1"><input type="hidden" name="id" value={a.id} /><input type="date" name="disposedOn" defaultValue={today} required aria-label={`Ausscheiden am (${a.number})`} className="rounded-md border border-line bg-bg px-1 py-0.5" /><button className="rounded-md border border-line px-2 py-0.5">Ausscheiden</button></form>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
