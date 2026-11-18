import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { cancelCustomerInvoiceDraft, createCreditNoteDraft, getCustomerInvoice, issueCustomerInvoice, markCustomerInvoicePaid } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";

async function issue(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/finance/out/${id}`, () => issueCustomerInvoice(ctx, id)); revalidatePath("/finance", "layout"); }
async function discard(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/finance/out/${id}`, () => cancelCustomerInvoiceDraft(ctx, id)); revalidatePath("/finance", "layout"); }
async function paid(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/finance/out/${id}`, () => markCustomerInvoicePaid(ctx, { id, paidOn: fd.get("paidOn") })); revalidatePath("/finance", "layout"); }
async function credit(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  const cn = await runAction(`/finance/out/${id}`, () => createCreditNoteDraft(ctx, id));
  redirect(`/finance/out/${cn.id}`);
}

const STATUS: Record<string, string> = { DRAFT: "Entwurf", ISSUED: "ausgestellt", CANCELLED: "verworfen" };

export default async function CustomerInvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let inv;
  try { inv = await getCustomerInvoice(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const t = new Map(inv.taxCodes.map((x) => [x.id, x])), a = new Map(inv.accounts.map((x) => [x.id, x]));
  const secondary = "rounded-md border border-line px-3 py-1.5";

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{inv.number ?? "Entwurf"} · {inv.customer.name}{inv.kind === "CREDIT" ? " (Gutschrift)" : ""}</h1>
        <p className="text-sm text-muted">Status: {STATUS[inv.status]}{inv.paidOn ? ` · bezahlt am ${inv.paidOn.toISOString().slice(0, 10)}` : ""}{inv.exported ? " · an die Steuerberatung exportiert" : ""} · Rechnungsdatum {inv.invoiceDate.toISOString().slice(0, 10)}{inv.dueDate ? ` · fällig ${inv.dueDate.toISOString().slice(0, 10)}` : ""}</p>
      </div>
      <ErrorBanner message={error} />
      <table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-2">Position</th><th className="text-right">Menge</th><th className="text-right">Einzelpreis</th><th>Konto</th><th>Steuer</th><th className="text-right">Netto</th></tr></thead>
        <tbody className="divide-y divide-line">
          {inv.lines.map((l) => <tr key={l.id}><td className="py-2">{l.description}</td><td className="text-right">{l.quantity.toString()}</td><td className="text-right">{formatMoney(l.unitPrice.toString(), inv.currency)}</td><td>{a.get(l.revenueAccountId)?.number ?? "fehlt"}</td><td>{t.get(l.taxCodeId)?.key}</td><td className="text-right">{formatMoney(l.netAmount.toString(), inv.currency)}</td></tr>)}
        </tbody>
        <tfoot><tr><td colSpan={5} className="py-2 text-right">Netto / Steuer / Brutto</td><td className="text-right">{formatMoney(inv.netTotal.toString(), inv.currency)} / {formatMoney(inv.taxTotal.toString(), inv.currency)} / <strong>{formatMoney(inv.grossTotal.toString(), inv.currency)}</strong></td></tr></tfoot>
      </table>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        {inv.status === "DRAFT" && can(ctx, "finance.invoice.out.issue") && <form action={issue}><input type="hidden" name="id" value={inv.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Ausstellen (Nummer vergeben)</button></form>}
        {inv.status === "DRAFT" && can(ctx, "finance.invoice.out.create") && <form action={discard}><input type="hidden" name="id" value={inv.id} /><button className={secondary}>Entwurf verwerfen</button></form>}
        {inv.status === "ISSUED" && <a href={`/finance/out/${inv.id}/pdf`} target="_blank" rel="noopener" className={secondary}>PDF öffnen</a>}
        {inv.status === "ISSUED" && <a href={`/finance/out/${inv.id}/xml`} className={secondary}>E-Rechnung (XML)</a>}
        {inv.status === "ISSUED" && inv.kind === "INVOICE" && can(ctx, "finance.invoice.out.create") && <form action={credit}><input type="hidden" name="id" value={inv.id} /><button className={secondary}>Gutschrift anlegen</button></form>}
        {inv.status === "ISSUED" && !inv.paidOn && can(ctx, "finance.invoice.out.issue") && (
          <form action={paid} className="flex items-end gap-2"><input type="hidden" name="id" value={inv.id} />
            <label>Bezahlt am<input type="date" name="paidOn" required className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
            <button className={secondary}>Als bezahlt markieren</button></form>
        )}
      </div>
      {inv.status === "ISSUED" && <p className="text-xs text-muted">Ausgestellte Rechnungen sind unveränderlich; Korrekturen erfolgen per Gutschrift. Anschrift, UID und Bankverbindung im PDF kommen aus „Finanzen → Einstellungen → Aussteller“ (Stand beim Ausstellen).</p>}
    </div>
  );
}
