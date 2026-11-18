import { notFound, redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { listCostCenters } from "@/modules/masterdata/service";
import { createOrder, decideRequest, getRequest, listSuppliers } from "@/modules/procurement/service";
import { STEP_PERMISSION } from "@/modules/procurement/rules";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  DRAFT: "Entwurf", SUBMITTED: "Eingereicht", APPROVED: "Freigegeben", REJECTED: "Abgelehnt", ORDERED: "Bestellt",
};
const STEP: Record<string, string> = { MANAGER: "Führungskraft", FINANCE: "Finanzen" };
const DECISION: Record<string, string> = { PENDING: "offen", APPROVED: "freigegeben", REJECTED: "abgelehnt" };

async function decide(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("requestId"));
  await runAction(`/procurement/${id}`, () =>
    decideRequest(ctx, { requestId: id, decision: formData.get("decision"), comment: formData.get("comment") || null }),
  );
  redirect(`/procurement/${id}`);
}

async function order(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(formData.get("requestId"));
  const result = await runAction(`/procurement/${id}`, () =>
    createOrder(ctx, { requestId: id, supplierId: formData.get("supplierId"), costCenterId: formData.get("costCenterId") }),
  );
  redirect(`/procurement/${id}${result.overBudget ? "?error=" + encodeURIComponent("Bestellung angelegt – Budget der Kostenstelle ist damit überschritten.") : ""}`);
}

export default async function RequestDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  if (!can(ctx, "procurement.request.create")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  let r;
  try { r = await getRequest(ctx, id); } catch (e) { if (e instanceof NotFoundError) notFound(); throw e; }

  const nextStep = r.status === "SUBMITTED" ? r.approvals.find((a) => a.status === "PENDING") : undefined;
  const canDecide = !!nextStep && r.requesterId !== ctx.userId && can(ctx, STEP_PERMISSION[nextStep.stepKey as keyof typeof STEP_PERMISSION]);
  const canOrder = r.status === "APPROVED" && can(ctx, "procurement.order.create");
  const [suppliers, costCenters] = canOrder
    ? await Promise.all([listSuppliers(ctx), listCostCenters(ctx)])
    : [[], []];
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{r.number} · {r.title}</h1>
        <p className="text-sm text-muted">Status: {STATUS[r.status]} · Gesamt {formatMoney(r.totalAmount.toString(), r.currency)}{r.costCenter ? ` · Kostenstelle ${r.costCenter.code}` : ""}</p>
      </div>
      <ErrorBanner message={error} />

      <table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-2">Position</th><th className="text-right">Menge</th><th className="text-right">Stückpreis</th></tr></thead>
        <tbody className="divide-y divide-line">
          {r.lines.map((l) => (
            <tr key={l.id}><td className="py-2">{l.description}</td><td className="text-right">{l.quantity.toString()}</td>
              <td className="text-right">{formatMoney(l.unitPrice.toString(), r.currency)}</td></tr>
          ))}
        </tbody>
      </table>

      <section>
        <h2 className="mb-2 font-medium">Freigaben</h2>
        <ol className="space-y-1 text-sm">
          {r.approvals.map((a) => (
            <li key={a.id}>{a.sequence}. {STEP[a.stepKey]}: {DECISION[a.status]}{a.decidedAt ? ` (${a.decidedAt.toLocaleString("de-AT", { timeZone: "Europe/Vienna" })})` : ""}{a.comment ? ` – ${a.comment}` : ""}</li>
          ))}
        </ol>
      </section>

      {canDecide && (
        <form action={decide} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <input type="hidden" name="requestId" value={r.id} />
          <label className="block">Kommentar (optional)<input name="comment" maxLength={500} className={input + " w-full"} /></label>
          <div className="flex gap-2">
            <button name="decision" value="APPROVE" className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">Freigeben ({STEP[nextStep!.stepKey]})</button>
            <button name="decision" value="REJECT" className="rounded-md border border-line px-3 py-1.5">Ablehnen</button>
          </div>
        </form>
      )}

      {canOrder && (
        <form action={order} className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
          <h2 className="font-medium">Bestellung anlegen</h2>
          <input type="hidden" name="requestId" value={r.id} />
          <div className="flex flex-wrap gap-3">
            <label>Lieferant
              <select name="supplierId" required className={input}>
                <option value="">–</option>
                {suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.number} · {s.name}</option>)}
              </select>
            </label>
            <label>Kostenstelle
              <select name="costCenterId" required defaultValue={r.costCenterId ?? ""} className={input}>
                <option value="">–</option>
                {costCenters.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
              </select>
            </label>
          </div>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">Bestellen</button>
        </form>
      )}

      {r.orders.length > 0 && (
        <section>
          <h2 className="mb-2 font-medium">Bestellungen</h2>
          <ul className="text-sm">{r.orders.map((o) => <li key={o.id}>{o.number} · {o.supplier.name} · Kostenstelle {o.costCenter.code} · {formatMoney(o.totalAmount.toString(), o.currency)}</li>)}</ul>
        </section>
      )}
    </div>
  );
}
