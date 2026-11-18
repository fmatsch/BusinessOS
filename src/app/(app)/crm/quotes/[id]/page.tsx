import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { acceptQuote, cancelQuote, declineQuote, duplicateQuote, getQuote, sendQuote, submitQuote } from "@/modules/crm/service";
import { displayStatus, type QuoteStatus } from "@/modules/crm/quote-rules";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../../action-helpers";

export const dynamic = "force-dynamic";

const here = (id: string) => `/crm/quotes/${id}`;
async function submit(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => submitQuote(ctx, id)); revalidatePath(here(id)); }
async function send(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => sendQuote(ctx, id)); revalidatePath(here(id)); }
async function cancel(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => cancelQuote(ctx, id)); revalidatePath(here(id)); }
async function decline(fd: FormData) { "use server"; const ctx = await requireContext(); const id = String(fd.get("id")); await runAction(here(id), () => declineQuote(ctx, id, String(fd.get("reason") ?? ""))); revalidatePath(here(id)); }
async function accept(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  const r = await runAction(here(id), () => acceptQuote(ctx, id));
  redirect(`/finance/out/${r.invoiceId}`);
}
async function copy(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("id"));
  const q = await runAction(here(id), () => duplicateQuote(ctx, id, String(fd.get("validUntil"))));
  redirect(here(q.id));
}

export default async function QuoteDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let q;
  try { q = await getQuote(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const status = q.status as QuoteStatus;
  const creator = can(ctx, "crm.quote.create");
  const today = new Date().toISOString().slice(0, 10);
  const valid = q.validUntil.toISOString().slice(0, 10);
  const secondary = "rounded-md border border-line px-3 py-1.5";

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/crm/quotes">← Angebote</Link> · <Link className="text-accent underline" href={`/crm/${q.customer.id}`}>{q.customer.name}</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">{q.number ?? "Entwurf"} · {q.title}</h1>
        <p className="text-sm text-muted">Status: {displayStatus(status, valid, today)} · gültig bis {valid}</p>
      </div>
      <ErrorBanner message={error} />
      <table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-2">Position</th><th className="text-right">Menge</th><th className="text-right">Einzelpreis</th><th className="text-right">Netto</th></tr></thead>
        <tbody className="divide-y divide-line">{q.lines.map((l) => <tr key={l.id}><td className="py-2">{l.description}</td><td className="text-right">{l.quantity.toString()}</td><td className="text-right">{formatMoney(l.unitPrice.toString(), q.currency)}</td><td className="text-right">{formatMoney(l.netAmount.toString(), q.currency)}</td></tr>)}</tbody>
        <tfoot><tr><td colSpan={3} className="py-2 text-right">Netto / Steuer / Brutto</td><td className="text-right">{formatMoney(q.netTotal.toString(), q.currency)} / {formatMoney(q.taxTotal.toString(), q.currency)} / <strong>{formatMoney(q.grossTotal.toString(), q.currency)}</strong></td></tr></tfoot>
      </table>
      {q.note && <p className="text-sm text-muted">{q.note}</p>}

      {q.approvals.length > 0 && (
        <section aria-label="Freigabe" className="space-y-1 text-sm">
          <h2 className="font-medium">Freigabe</h2>
          <ul>{q.approvals.map((a) => <li key={a.id}>{a.label}: {a.status === "PENDING" ? "offen" : a.status === "APPROVED" ? "freigegeben" : "abgelehnt"}{a.comment ? ` – ${a.comment}` : ""}</li>)}</ul>
        </section>
      )}

      {creator && (
        <div className="flex flex-wrap items-end gap-3 text-sm">
          {status === "DRAFT" && <form action={submit}><input type="hidden" name="id" value={q.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Zur Freigabe einreichen</button></form>}
          {status === "APPROVED" && <form action={send}><input type="hidden" name="id" value={q.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Versenden (Nummer vergeben)</button></form>}
          {status === "SENT" && can(ctx, "finance.invoice.out.create") && <form action={accept}><input type="hidden" name="id" value={q.id} /><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Kunde hat angenommen → Rechnungsentwurf</button></form>}
          {status === "SENT" && (
            <form action={decline} className="flex items-end gap-2"><input type="hidden" name="id" value={q.id} />
              <label>Grund<input name="reason" maxLength={200} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
              <button className={secondary}>Kunde hat abgelehnt</button></form>
          )}
          {["DRAFT", "PENDING", "APPROVED"].includes(status) && <form action={cancel}><input type="hidden" name="id" value={q.id} /><button className={secondary}>Verwerfen</button></form>}
          <form action={copy} className="flex items-end gap-2"><input type="hidden" name="id" value={q.id} />
            <label>Kopie gültig bis<input type="date" name="validUntil" required min={today} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
            <button className={secondary}>Als Entwurf kopieren</button></form>
        </div>
      )}
      <div className="flex flex-wrap gap-3 text-sm">
        {q.number && <a href={`/crm/quotes/${q.id}/pdf`} target="_blank" rel="noopener" className={secondary}>PDF öffnen</a>}
        {q.invoiceId && can(ctx, "finance.invoice.read") && <Link className={secondary} href={`/finance/out/${q.invoiceId}`}>Rechnungsentwurf ansehen</Link>}
      </div>
    </div>
  );
}
