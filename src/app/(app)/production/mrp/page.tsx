import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createProductionOrder, runMrp } from "@/modules/production/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/production/mrp";

async function makeOrder(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const o = await runAction(BACK, () => createProductionOrder(ctx, { itemId: fd.get("itemId"), quantity: String(fd.get("quantity")) }));
  redirect(`/production/${o.id}`);
}

export default async function MrpPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let plan;
  try { plan = await runMrp(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "production.order.manage");
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/production">← Fertigung</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Bedarfsplanung</h1>
        <p className="text-sm text-muted">Nettobedarf = Kundenbedarf (bestätigte Aufträge, noch nicht geliefert) + Bedarf aus übergeordneten Stücklisten + Mindestbestand − Bestand − freigegebene Fertigung. Es werden nur Vorschläge gerechnet, nichts gebucht. Nicht berücksichtigt: Wiederbeschaffungszeiten, Losgrößen, offene Bestellungen (Bestellpositionen kennen keine Artikel), Reservierungen.</p>
      </div>
      <ErrorBanner message={error ?? plan.error ?? undefined} />
      {plan.suggestions.length === 0 && !plan.error ? <p className="text-sm text-muted">Kein Bedarf: alles gedeckt.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Planungsvorschläge</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Artikel</th><th scope="col">Stufe</th><th scope="col">Vorschlag</th><th scope="col" className="text-right">Menge</th><th scope="col" className="text-right">Bedarf</th><th scope="col" className="text-right">Bestand</th><th scope="col" className="text-right">Geplant</th><th scope="col" className="text-right">Mindestbestand</th><th /></tr></thead>
          <tbody className="divide-y divide-line">
            {plan.suggestions.map((s) => (
              <tr key={s.itemId}>
                <td className="py-1.5">{s.number} {s.name}</td><td>{s.level}</td><td>{s.action === "MAKE" ? "Fertigen" : "Beschaffen"}</td>
                <td className="text-right font-medium">{s.quantity.toString()} {s.unit}</td><td className="text-right">{s.gross.toString()}</td><td className="text-right">{s.onHand.toString()}</td><td className="text-right">{s.plannedReceipts.toString()}</td><td className="text-right">{s.safety.toString()}</td>
                <td>
                  {s.action === "MAKE" && manage && <form action={makeOrder}><input type="hidden" name="itemId" value={s.itemId} /><input type="hidden" name="quantity" value={s.quantity.toString()} /><button className="rounded-md border border-line px-2 py-0.5">Fertigungsauftrag anlegen</button></form>}
                  {s.action === "BUY" && <Link className="text-accent underline" href="/procurement">Zur Beschaffung</Link>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
