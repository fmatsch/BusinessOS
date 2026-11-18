import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { addActivity, anonymizeContact, createContact, getCrmCustomer } from "@/modules/crm/service";
import { ACTIVITY_LABEL, ACTIVITY_TYPES } from "@/modules/crm/schema";
import { displayStatus, type QuoteStatus } from "@/modules/crm/quote-rules";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";

async function contact(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("customerId"));
  await runAction(`/crm/${id}`, () => createContact(ctx, { customerId: id, name: fd.get("name"), position: fd.get("position"), email: fd.get("email"), phone: fd.get("phone"), note: fd.get("note") }));
  revalidatePath(`/crm/${id}`);
}
async function erase(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("customerId"));
  await runAction(`/crm/${id}`, () => anonymizeContact(ctx, String(fd.get("contactId"))));
  revalidatePath(`/crm/${id}`);
}
async function activity(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("customerId"));
  await runAction(`/crm/${id}`, () => addActivity(ctx, { customerId: id, contactId: fd.get("contactId"), type: fd.get("type"), occurredOn: fd.get("occurredOn"), subject: fd.get("subject"), body: fd.get("body") }));
  revalidatePath(`/crm/${id}`);
}

export default async function CustomerFile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let d;
  try { d = await getCrmCustomer(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const { customer: c, contacts, activities, quotes, invoices } = d;
  const writer = can(ctx, "crm.write"), eraser = can(ctx, "crm.contact.erase");
  const today = new Date().toISOString().slice(0, 10);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  const primary = "rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg";
  const activeContacts = contacts.filter((x) => x.active);

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/crm">← Alle Kunden</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">{c.number} {c.name}</h1>
        <p className="text-sm text-muted">{[c.street, [c.zip, c.city].filter(Boolean).join(" "), c.country].filter(Boolean).join(", ")}{c.uid ? ` · UID ${c.uid}` : ""} · Zahlungsziel {c.paymentTermsDays} Tage</p>
      </div>
      <ErrorBanner message={error} />

      <section className="space-y-2" aria-label="Kontakte">
        <h2 className="font-medium">Ansprechpersonen</h2>
        {writer && (
          <form action={contact} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-5">
            <input type="hidden" name="customerId" value={c.id} />
            <label>Name<input name="name" required maxLength={120} className={input} /></label>
            <label>Funktion<input name="position" maxLength={80} className={input} /></label>
            <label>E-Mail<input name="email" maxLength={120} className={input} /></label>
            <label>Telefon<input name="phone" maxLength={40} className={input} /></label>
            <div className="flex items-end"><button className={primary}>Kontakt anlegen</button></div>
          </form>
        )}
        {contacts.length === 0 ? <p className="text-sm text-muted">Noch keine Kontakte.</p> : (
          <ul className="divide-y divide-line text-sm">
            {contacts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className={p.active ? "" : "text-muted"}>{p.name}{p.position ? ` · ${p.position}` : ""}{p.email ? ` · ${p.email}` : ""}{p.phone ? ` · ${p.phone}` : ""}</span>
                {eraser && p.active && (
                  <form action={erase}><input type="hidden" name="customerId" value={c.id} /><input type="hidden" name="contactId" value={p.id} />
                    <button className="rounded-md border border-line px-2 py-0.5" aria-label={`Personenbezogene Daten von ${p.name} löschen`}>Daten löschen</button></form>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">„Daten löschen“ entfernt Name, Funktion, E-Mail, Telefon und Notiz (DSGVO-Löschwunsch). Freitext in Aktivitäten wird nicht automatisch bereinigt.</p>
      </section>

      <section className="space-y-2" aria-label="Aktivitäten">
        <h2 className="font-medium">Aktivitäten</h2>
        {writer && (
          <form action={activity} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-6">
            <input type="hidden" name="customerId" value={c.id} />
            <label>Art<select name="type" className={input}>{ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY_LABEL[t]}</option>)}</select></label>
            <label>Datum<input type="date" name="occurredOn" defaultValue={today} max={today} required className={input} /></label>
            <label>Kontakt<select name="contactId" className={input}><option value="">–</option>{activeContacts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="sm:col-span-3">Betreff<input name="subject" required maxLength={160} className={input} /></label>
            <label className="sm:col-span-5">Notiz<input name="body" maxLength={2000} className={input} /></label>
            <div className="flex items-end"><button className={primary}>Eintragen</button></div>
          </form>
        )}
        {activities.length === 0 ? <p className="text-sm text-muted">Noch keine Aktivitäten.</p> : (
          <ul className="divide-y divide-line text-sm">
            {activities.map((a) => (
              <li key={a.id} className="py-2">
                <strong>{ACTIVITY_LABEL[a.type as keyof typeof ACTIVITY_LABEL]}</strong> · {a.occurredOn.toISOString().slice(0, 10)}{a.contact ? ` · ${a.contact.name}` : ""} · {a.subject}
                {a.body && <p className="text-muted">{a.body}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">Aktivitäten sind unveränderlich; Korrekturen erfolgen als neuer Eintrag.</p>
      </section>

      <section className="space-y-2" aria-label="Angebote">
        <h2 className="font-medium">Angebote</h2>
        {quotes.length === 0 ? <p className="text-sm text-muted">Noch keine Angebote.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Nummer</th><th>Titel</th><th>Gültig bis</th><th className="text-right">Brutto</th><th>Status</th></tr></thead>
            <tbody className="divide-y divide-line">
              {quotes.map((q) => (
                <tr key={q.id}>
                  <td className="py-2"><Link className="text-accent underline" href={`/crm/quotes/${q.id}`}>{q.number ?? "Entwurf"}</Link></td><td>{q.title}</td>
                  <td>{q.validUntil.toISOString().slice(0, 10)}</td><td className="text-right">{formatMoney(q.grossTotal.toString(), q.currency)}</td>
                  <td>{displayStatus(q.status as QuoteStatus, q.validUntil.toISOString().slice(0, 10), today)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {invoices && (
        <section className="space-y-2" aria-label="Rechnungen">
          <h2 className="font-medium">Letzte Rechnungen</h2>
          {invoices.length === 0 ? <p className="text-sm text-muted">Noch keine Rechnungen.</p> : (
            <ul className="divide-y divide-line text-sm">
              {invoices.map((i) => (
                <li key={i.id} className="flex justify-between py-2"><Link className="text-accent underline" href={`/finance/out/${i.id}`}>{i.number ?? "Entwurf"}{i.kind === "CREDIT" ? " (Gutschrift)" : ""}</Link>
                  <span>{i.invoiceDate.toISOString().slice(0, 10)} · {formatMoney(i.grossTotal.toString(), i.currency)} · {i.paidOn ? "bezahlt" : i.status === "ISSUED" ? "offen" : "Entwurf"}</span></li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
