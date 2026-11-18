import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { budgetOverview, setBudget } from "@/modules/budget/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";

async function save(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const year = String(formData.get("fiscalYear"));
  await runAction(`/budgets?year=${year}`, () =>
    setBudget(ctx, { costCenterId: formData.get("costCenterId"), fiscalYear: year, amount: formData.get("amount") }),
  );
  revalidatePath("/budgets");
}

export default async function BudgetsPage({ searchParams }: { searchParams: Promise<{ error?: string; year?: string }> }) {
  const { error, year: yearParam } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "finance.budget.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const year = Number(yearParam) || new Date().getFullYear();
  const rows = await budgetOverview(ctx, year);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Budgets {year}</h1>
      <p className="text-sm text-muted">Gebunden = Summe der Bestellungen der Kostenstelle im Jahr (abgeleitet, nicht manuell gepflegt).</p>
      <ErrorBanner message={error} />
      {can(ctx, "finance.budget.write") && rows.length > 0 && (
        <form action={save} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <input type="hidden" name="fiscalYear" value={year} />
          <label>Kostenstelle
            <select name="costCenterId" required className={input}>
              {rows.map((r) => <option key={r.costCenterId} value={r.costCenterId}>{r.code} · {r.name}</option>)}
            </select>
          </label>
          <label>Budget ({ctx.currency})<input name="amount" required inputMode="decimal" className={input} /></label>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">Speichern</button>
        </form>
      )}
      {rows.length === 0 ? <p className="text-sm text-muted">Noch keine Kostenstellen.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Kostenstelle</th><th className="text-right">Budget</th><th className="text-right">Gebunden</th><th className="text-right">Verfügbar</th></tr></thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.costCenterId}>
                <td className="py-2">{r.code} · {r.name}</td>
                <td className="text-right">{r.budget ? formatMoney(r.budget.toString(), ctx.currency) : "kein Budget"}</td>
                <td className="text-right">{formatMoney(r.committed.toString(), ctx.currency)}</td>
                <td className={"text-right " + (r.remaining?.isNegative() ? "font-medium text-red-600" : "")}>
                  {r.remaining ? formatMoney(r.remaining.toString(), ctx.currency) : "–"}{r.remaining?.isNegative() ? " (überschritten)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
