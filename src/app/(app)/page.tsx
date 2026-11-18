import { db } from "@/lib/db";
import { requireContext } from "@/platform/tenancy/context";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const ctx = await requireContext();
  // Alle Kennzahlen stammen aus der Datenbank der aktiven Organisation.
  const [departments, costCenters, members, audit] = await Promise.all([
    db.department.count({ where: { organizationId: ctx.organizationId } }),
    db.costCenter.count({ where: { organizationId: ctx.organizationId } }),
    db.organizationMembership.count({ where: { organizationId: ctx.organizationId } }),
    ctx.permissions.has("org.audit.read")
      ? db.auditLog.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 8 })
      : Promise.resolve(null),
  ]);

  const stats = [
    ["Abteilungen", departments],
    ["Kostenstellen", costCenters],
    ["Mitglieder", members],
  ] as const;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">{ctx.organizationName}</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {stats.map(([label, n]) => (
          <div key={label} className="rounded-xl border border-line bg-surface p-5">
            <div className="text-sm text-muted">{label}</div>
            <div className="text-3xl font-semibold">{n}</div>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted">
        Finanz-, Budget- und Beschaffungskennzahlen erscheinen, sobald die jeweiligen Module umgesetzt sind.
      </p>
      {audit && (
        <section>
          <h2 className="mb-2 font-medium">Letzte Aktivität</h2>
          {audit.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
            <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
              {audit.map((a) => (
                <li key={a.id} className="flex justify-between px-4 py-2">
                  <span>{a.action}</span>
                  <time className="text-muted" dateTime={a.createdAt.toISOString()}>
                    {a.createdAt.toLocaleString("de-AT", { timeZone: "Europe/Vienna" })}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
