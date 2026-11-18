import { db } from "@/lib/db";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const ctx = await requireContext();
  if (!can(ctx, "org.audit.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const entries = await db.auditLog.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Audit-Log</h1>
      <p className="text-sm text-muted">Letzte {entries.length} Einträge. Einträge sind nur lesbar.</p>
      {entries.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Zeit</th><th>Aktion</th><th>Objekt</th><th>Benutzer</th><th>Details</th></tr></thead>
          <tbody className="divide-y divide-line align-top">
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="py-2 whitespace-nowrap">{e.createdAt.toLocaleString("de-AT", { timeZone: "Europe/Vienna" })}</td>
                <td>{e.action}</td><td>{e.entityType}</td><td>{e.actorType === "USER" ? (e.actorUserId ?? "–").slice(0, 8) : e.actorType}</td>
                <td className="max-w-md break-words font-mono text-xs text-muted">{e.after ? JSON.stringify(e.after) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
