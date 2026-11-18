import Link from "next/link";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { listCrmCustomers } from "@/modules/crm/service";

export const dynamic = "force-dynamic";

export default async function CrmPage() {
  const ctx = await requireContext();
  let customers;
  try { customers = await listCrmCustomers(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">CRM</h1>
        <p className="text-sm text-muted">Kundenakte mit Ansprechpersonen und Aktivitäten, dazu Angebote mit Freigabe. Kunden werden in den Finanzen angelegt (Einstellungen → Kunden); es gibt keine Leads, Kampagnen oder E-Mail-Anbindung.</p>
      </div>
      <p className="text-sm"><Link className="text-accent underline" href="/crm/quotes">Angebote{can(ctx, "crm.quote.approve") ? " und Freigaben" : ""}</Link></p>
      {customers.length === 0 ? <p className="text-sm text-muted">Noch keine Kunden.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Kunde</th><th>Ort</th><th className="text-right">Kontakte</th><th>Letzte Aktivität</th><th className="text-right">Offene Angebote</th></tr></thead>
          <tbody className="divide-y divide-line">
            {customers.map((c) => (
              <tr key={c.id}>
                <td className="py-2"><Link className="text-accent underline" href={`/crm/${c.id}`}>{c.number} {c.name}</Link></td>
                <td>{c.city ?? "–"}</td><td className="text-right">{c.contactCount}</td>
                <td>{c.lastActivity ? c.lastActivity.toISOString().slice(0, 10) : "–"}</td><td className="text-right">{c.openQuotes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
