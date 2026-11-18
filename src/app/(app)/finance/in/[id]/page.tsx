import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { approveSupplierInvoice, cancelSupplierInvoice, getSupplierInvoice, markSupplierInvoicePaid } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";

async function approve(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/finance/in/${id}`, () => approveSupplierInvoice(ctx, id)); revalidatePath("/finance", "layout"); }
async function cancel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/finance/in/${id}`, () => cancelSupplierInvoice(ctx, id)); revalidatePath("/finance", "layout"); }
async function paid(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(`/finance/in/${id}`, () => markSupplierInvoicePaid(ctx, { id, paidOn: fd.get("paidOn") })); revalidatePath("/finance", "layout"); }

const STATUS: Record<string, string> = { DRAFT: "wartet auf Freigabe", APPROVED: "freigegeben", CANCELLED: "storniert" };

export default async function SupplierInvoicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let inv;
  try { inv = await getSupplierInvoice(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const t = new Map(inv.taxCodes.map((x) => [x.id, x])), a = new Map(inv.accounts.map((x) => [x.id, x]));
  const secondary = "rounded-md border border-line px-3 py-1.5";

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{inv.voucherNumber ?? "Entwurf"} · {inv.supplier.name} · {inv.invoiceNumber}{inv.kind === "CREDIT" ? " (Gutschrift)" : ""}</h1>
        <p className="text-sm text-muted">Status: {STATUS[inv.status]}{inv.paidOn ? ` · bezahlt am ${inv.paidOn.toISOString().slice(0, 10)}` : ""}{inv.exported ? " · an die Steuerberatung exportiert" : ""} · Rechnungsdatum {inv.invoiceDate.toISOString().slice(0, 10)}</p>
      </div>
      <ErrorBanner message={error} />
      <table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-2">Position</th><th>Konto</th><th>Steuer</th><th className="text-right">Netto</th></tr></thead>
        <tbody className="divide-y divide-line">
          {inv.lines.map((l) => <tr key={l.id}><td className="py-2">{l.description}</td><td>{a.get(l.expenseAccountId)?.number ?? "fehlt"}</td><td>{t.get(l.taxCodeId)?.key}</td><td className="text-right">{formatMoney(l.netAmount.toString(), inv.currency)}</td></tr>)}
        </tbody>
        <tfoot><tr><td colSpan={3} className="py-2 text-right">Netto / Steuer / Brutto</td><td className="text-right">{formatMoney(inv.netTotal.toString(), inv.currency)} / {formatMoney(inv.taxTotal.toString(), inv.currency)} / <strong>{formatMoney(inv.grossTotal.toString(), inv.currency)}</strong></td></tr></tfoot>
      </table>
      {inv.fileId && can(ctx, "finance.invoice.read") && <p className="text-sm"><a className="text-accent underline" href={`/finance/files/${inv.fileId}`}>Belegdatei ansehen</a></p>}

      <div className="flex flex-wrap items-end gap-3 text-sm">
        {inv.status === "DRAFT" && can(ctx, "finance.invoice.in.approve") && (
          <form action={approve}><input type="hidden" name="id" value={inv.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Freigeben</button></form>
        )}
        {inv.status !== "CANCELLED" && !inv.exported && (inv.status === "DRAFT" ? can(ctx, "finance.invoice.in.create") : can(ctx, "finance.invoice.in.approve")) && (
          <form action={cancel}><input type="hidden" name="id" value={inv.id} /><button className={secondary}>Stornieren</button></form>
        )}
        {inv.status === "APPROVED" && !inv.paidOn && can(ctx, "finance.invoice.in.approve") && (
          <form action={paid} className="flex items-end gap-2"><input type="hidden" name="id" value={inv.id} />
            <label>Bezahlt am<input type="date" name="paidOn" required className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
            <button className={secondary}>Als bezahlt markieren</button></form>
        )}
      </div>
      {inv.status === "DRAFT" && <p className="text-xs text-muted">Freigabe nach dem Vier-Augen-Prinzip: die Person, die den Beleg erfasst hat, kann ihn nicht selbst freigeben.</p>}
    </div>
  );
}
