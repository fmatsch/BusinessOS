import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { addExpenseLine, cancelExpenseReport, getExpenseReport, markExpensePaid, removeExpenseLine, submitExpenseReport } from "@/modules/expenses/service";
import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/modules/expenses/schema";
import { STATUS_LABEL, type ExpenseStatus } from "@/modules/expenses/rules";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const here = (id: string) => `/expenses/${id}`;

async function addLine(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("reportId"));
  const f = fd.get("receipt");
  const receipt = f instanceof File && f.size > 0 ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null;
  await runAction(here(id), () => addExpenseLine(ctx, { reportId: id, date: fd.get("date"), category: fd.get("category"), description: fd.get("description"), amount: String(fd.get("amount") ?? "").replace(",", ".") }, receipt));
  revalidatePath(here(id));
}
async function removeLine(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("reportId")); await runAction(here(id), () => removeExpenseLine(ctx, String(fd.get("lineId")))); revalidatePath(here(id)); }
async function submit(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("reportId")); await runAction(here(id), () => submitExpenseReport(ctx, id)); revalidatePath(here(id)); }
async function cancel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("reportId")); await runAction(here(id), () => cancelExpenseReport(ctx, id)); revalidatePath(here(id)); }
async function paid(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("reportId")); await runAction(here(id), () => markExpensePaid(ctx, { reportId: id, paidOn: fd.get("paidOn") })); revalidatePath(here(id)); }

export default async function ExpenseDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let r;
  try { r = await getExpenseReport(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const status = r.status as ExpenseStatus;
  const today = new Date().toISOString().slice(0, 10);
  const draft = r.isOwn && status === "DRAFT";
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";
  const secondary = "rounded-md border border-line px-3 py-1.5";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/expenses">← Abrechnungen</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">{r.number ?? "Entwurf"} · {r.title}</h1>
        <p className="text-sm text-muted">{r.employeeName} · Status: {STATUS_LABEL[status]}{r.paidOn ? ` am ${r.paidOn.toISOString().slice(0, 10)}` : ""}{r.tripFrom ? ` · Reise ${r.tripFrom.toISOString().slice(0, 10)}${r.tripTo ? ` bis ${r.tripTo.toISOString().slice(0, 10)}` : ""}` : ""}</p>
      </div>
      <ErrorBanner message={error} />

      <table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-2">Datum</th><th>Art</th><th>Beschreibung</th><th>Beleg</th><th className="text-right">Betrag</th>{draft && <th />}</tr></thead>
        <tbody className="divide-y divide-line">
          {r.lines.map((l) => (
            <tr key={l.id}>
              <td className="py-2">{l.date.toISOString().slice(0, 10)}</td><td>{CATEGORY_LABEL[l.category as Category]}</td>
              <td>{l.description}{l.quantity ? ` (${l.quantity.toString()} km)` : ""}</td>
              <td>{l.receiptFileId ? <a className="text-accent underline" href={`/expenses/receipt/${l.id}`} target="_blank" rel="noopener">ansehen</a> : "–"}</td>
              <td className="text-right">{formatMoney(l.amount.toString(), r.currency)}</td>
              {draft && <td><form action={removeLine}><input type="hidden" name="reportId" value={r.id} /><input type="hidden" name="lineId" value={l.id} /><button className="rounded-md border border-line px-2 py-0.5" aria-label={`Position ${l.description} entfernen`}>Entfernen</button></form></td>}
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={4} className="py-2 text-right">Summe</td><td className="text-right"><strong>{formatMoney(r.totalAmount.toString(), r.currency)}</strong></td>{draft && <td />}</tr></tfoot>
      </table>

      {draft && (
        <form action={addLine} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
          <input type="hidden" name="reportId" value={r.id} />
          <h2 className="font-medium sm:col-span-6">Position hinzufügen</h2>
          <label>Datum<input type="date" name="date" defaultValue={today} max={today} required className={input} /></label>
          <label>Art<select name="category" className={input}>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>
          <label className="sm:col-span-2">Beschreibung<input name="description" required maxLength={200} className={input + " w-full"} /></label>
          <label>Betrag (bei Kilometergeld: km)<input name="amount" required inputMode="decimal" className={input} /></label>
          <label>Beleg (PDF, PNG, JPEG)<input type="file" name="receipt" accept="application/pdf,image/png,image/jpeg" className="mt-1 block" /></label>
          <div className="sm:col-span-6"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Hinzufügen</button></div>
        </form>
      )}

      {r.approvals.length > 0 && (
        <section aria-label="Freigabe" className="space-y-1 text-sm">
          <h2 className="font-medium">Freigabe</h2>
          <ul>{r.approvals.map((a) => <li key={a.id}>{a.label}: {a.status === "PENDING" ? "offen" : a.status === "APPROVED" ? "freigegeben" : "abgelehnt"}{a.comment ? ` – ${a.comment}` : ""}</li>)}</ul>
        </section>
      )}

      <div className="flex flex-wrap items-end gap-3 text-sm">
        {draft && <form action={submit}><input type="hidden" name="reportId" value={r.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Einreichen</button></form>}
        {r.isOwn && (status === "DRAFT" || status === "SUBMITTED") && <form action={cancel}><input type="hidden" name="reportId" value={r.id} /><button className={secondary}>{status === "DRAFT" ? "Verwerfen" : "Zurückziehen"}</button></form>}
        {status === "APPROVED" && can(ctx, "expense.pay") && (
          <form action={paid} className="flex items-end gap-2"><input type="hidden" name="reportId" value={r.id} />
            <label>Ausbezahlt am<input type="date" name="paidOn" defaultValue={today} max={today} required className={input} /></label>
            <button className={secondary}>Als ausbezahlt vermerken</button></form>
        )}
      </div>
      {status === "SUBMITTED" && !r.isOwn && <p className="text-sm text-muted">Die Freigabe erfolgt in der Übersicht „Zur Freigabe“ unter <Link className="text-accent underline" href="/expenses">Spesen</Link>.</p>}
    </div>
  );
}
