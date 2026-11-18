import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createDunningNotice, listOpenItems } from "@/modules/finance/receivables";
import { BUCKET_LABEL, LEVEL_TITLE, MAX_LEVEL, MIN_DAYS_BETWEEN } from "@/modules/finance/dunning";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/finance/receivables";

async function remind(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction(BACK, () => createDunningNotice(ctx, { invoiceId: fd.get("invoiceId"), feeAmount: fd.get("feeAmount") || "0", note: fd.get("note") }));
  revalidatePath(BACK);
}

export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let data;
  try { data = await listOpenItems(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const { rows, summary } = data;
  const canDun = can(ctx, "finance.dunning.create");
  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Offene Posten und Mahnwesen</h1>
        <p className="text-sm text-muted">Ausgestellte, noch nicht bezahlte Rechnungen abzüglich Gutschriften. Mahnstufen: {Object.values(LEVEL_TITLE).join(" → ")}; Mindestabstand {MIN_DAYS_BETWEEN} Tage. Verzugszinsen werden nicht berechnet, eine Gebühr kann von Hand eingetragen werden.</p>
      </div>
      <ErrorBanner message={error} />
      <ul className="grid gap-3 sm:grid-cols-5" aria-label="Alterung">
        {(Object.keys(BUCKET_LABEL) as (keyof typeof BUCKET_LABEL)[]).map((b) => (
          <li key={b} className="rounded-xl border border-line bg-surface p-3 text-sm"><div className="text-muted">{BUCKET_LABEL[b]}</div><div className="font-medium">{formatMoney(summary[b].toString())}</div></li>
        ))}
      </ul>
      {rows.length === 0 ? <p className="text-sm text-muted">Keine offenen Posten.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Rechnung</th><th>Kunde</th><th>Fällig</th><th className="text-right">Tage</th><th className="text-right">Offen</th><th>Mahnstufe</th>{canDun && <th />}</tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="py-2"><Link className="text-accent underline" href={`/finance/out/${r.id}`}>{r.number}</Link></td>
                <td>{r.customer.name}</td><td>{r.dueDate}</td>
                <td className="text-right">{r.daysOverdue > 0 ? r.daysOverdue : "–"}</td>
                <td className="text-right">{formatMoney(r.open.toString(), r.currency)}</td>
                <td>{r.notices.length === 0 ? "keine" : r.notices.map((n) => <a key={n.id} className="mr-2 text-accent underline" href={`/finance/receivables/pdf/${n.id}`} target="_blank" rel="noopener">{LEVEL_TITLE[n.level]} ({n.issuedOn})</a>)}</td>
                {canDun && (
                  <td>
                    {r.next.allowed ? (
                      <form action={remind} className="flex items-center gap-1">
                        <input type="hidden" name="invoiceId" value={r.id} />
                        <input name="feeAmount" inputMode="decimal" placeholder="Gebühr" aria-label={`Gebühr für ${r.number}`} className="w-20 rounded-md border border-line bg-bg px-2 py-0.5" />
                        <button className="rounded-md border border-line px-2 py-0.5">{LEVEL_TITLE[r.next.level]} erstellen</button>
                      </form>
                    ) : <span className="text-muted">{r.lastLevel >= MAX_LEVEL ? "Höchste Stufe erreicht" : r.next.reason}</span>}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
