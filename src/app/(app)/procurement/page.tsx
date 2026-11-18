import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { listCostCenters } from "@/modules/masterdata/service";
import { createRequest, listOrders, listPendingApprovals, listRequests } from "@/modules/procurement/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  DRAFT: "Entwurf", SUBMITTED: "Eingereicht", APPROVED: "Freigegeben", REJECTED: "Abgelehnt", ORDERED: "Bestellt",
};
const LINES = 5;

async function create(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const lines = Array.from({ length: LINES }, (_, i) => ({
    description: String(formData.get(`desc${i}`) ?? "").trim(),
    quantity: String(formData.get(`qty${i}`) ?? ""),
    unitPrice: String(formData.get(`price${i}`) ?? ""),
  })).filter((l) => l.description !== "");
  const request = await runAction("/procurement", () =>
    createRequest(ctx, { title: formData.get("title"), costCenterId: formData.get("costCenterId") || null, lines }),
  );
  redirect(`/procurement/${request.id}`);
}

export default async function ProcurementPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "procurement.request.create")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const [requests, pending, orders, costCenters] = await Promise.all([
    listRequests(ctx),
    listPendingApprovals(ctx),
    can(ctx, "procurement.order.create") ? listOrders(ctx) : Promise.resolve([]),
    can(ctx, "master.costcenter.read") ? listCostCenters(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Beschaffung</h1>
      <ErrorBanner message={error} />

      <section className="space-y-3">
        <h2 className="font-medium">Neue Bestellanforderung</h2>
        <form action={create} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label>Titel<input name="title" required maxLength={160} className={input} /></label>
            <label>Kostenstelle (optional)
              <select name="costCenterId" className={input}>
                <option value="">–</option>
                {costCenters.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </select>
            </label>
          </div>
          <div className="space-y-2">
            {Array.from({ length: LINES }, (_, i) => (
              <div key={i} className="grid grid-cols-[1fr_6rem_8rem] gap-2">
                <input name={`desc${i}`} placeholder={`Position ${i + 1}`} maxLength={200} aria-label={`Beschreibung ${i + 1}`} className={input} />
                <input name={`qty${i}`} inputMode="decimal" placeholder="Menge" aria-label={`Menge ${i + 1}`} className={input} />
                <input name={`price${i}`} inputMode="decimal" placeholder="Stückpreis" aria-label={`Stückpreis ${i + 1}`} className={input} />
              </div>
            ))}
          </div>
          <p className="text-muted">Über 5.000 {ctx.currency} ist zusätzlich die Freigabe durch Finanzen nötig.</p>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Einreichen</button>
        </form>
      </section>

      {pending.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">Wartet auf Ihre Freigabe</h2>
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
            {pending.map((a) => (
              <li key={a.id} className="flex justify-between px-4 py-2">
                <Link className="text-accent underline" href={`/procurement/${a.requestId}`}>{a.request.number} · {a.request.title}</Link>
                <span>{formatMoney(a.request.totalAmount.toString(), a.request.currency)} · Schritt {a.stepKey === "FINANCE" ? "Finanzen" : "Führungskraft"}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">Anforderungen</h2>
        {requests.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Nr.</th><th>Titel</th><th>Status</th><th className="text-right">Betrag</th></tr></thead>
            <tbody className="divide-y divide-line">
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="py-2"><Link className="text-accent underline" href={`/procurement/${r.id}`}>{r.number}</Link></td>
                  <td>{r.title}</td><td>{STATUS[r.status]}</td>
                  <td className="text-right">{formatMoney(r.totalAmount.toString(), r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {can(ctx, "procurement.order.create") && (
        <section className="space-y-2">
          <h2 className="font-medium">Bestellungen</h2>
          {orders.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
            <table className="w-full text-left text-sm">
              <thead className="text-muted"><tr><th className="py-2">Nr.</th><th>Lieferant</th><th>Kostenstelle</th><th>Anforderung</th><th className="text-right">Betrag</th></tr></thead>
              <tbody className="divide-y divide-line">
                {orders.map((o) => (
                  <tr key={o.id}><td className="py-2">{o.number}</td><td>{o.supplier.name}</td><td>{o.costCenter.code}</td><td>{o.request?.number ?? "–"}</td>
                    <td className="text-right">{formatMoney(o.totalAmount.toString(), o.currency)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
