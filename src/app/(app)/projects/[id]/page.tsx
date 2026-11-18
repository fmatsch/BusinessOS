import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { billProject, getProject, reverseProjectTime, setProjectStatus } from "@/modules/projects/service";
import { minutesToHours } from "@/modules/projects/rules";
import { listTaxCodes } from "@/modules/finance/service";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const here = (id: string) => `/projects/${id}`;

async function reverse(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("projectId"));
  await runAction(here(id), () => reverseProjectTime(ctx, String(fd.get("timeId")), String(fd.get("reason") ?? "")));
  revalidatePath(here(id));
}
async function status(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("projectId"));
  await runAction(here(id), () => setProjectStatus(ctx, id, fd.get("to") === "CLOSED" ? "CLOSED" : "ACTIVE"));
  revalidatePath(here(id));
}
async function bill(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const id = String(fd.get("projectId"));
  const r = await runAction(here(id), () => billProject(ctx, { projectId: id, upTo: fd.get("upTo"), taxCodeId: fd.get("taxCodeId"), revenueAccountId: null }));
  redirect(`/finance/out/${r.invoiceId}`);
}

export default async function ProjectDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, { error }] = await Promise.all([params, searchParams]);
  const ctx = await requireContext();
  let p;
  try { p = await getProject(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const biller = can(ctx, "project.bill"), manage = can(ctx, "project.manage");
  const taxCodes = biller && can(ctx, "finance.master.read") ? (await listTaxCodes(ctx)).filter((t) => t.direction === "OUTPUT" && t.active) : [];
  const today = new Date().toISOString().slice(0, 10);
  const secondary = "rounded-md border border-line px-3 py-1.5";
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/projects">← Projekte</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">{p.number} · {p.name}</h1>
        <p className="text-sm text-muted">
          {p.status === "ACTIVE" ? "aktiv" : "abgeschlossen"} · gebucht {minutesToHours(p.bookedMinutes).toString()} h · abgerechnet {minutesToHours(p.billedMinutes).toString()} h · offen {minutesToHours(p.openMinutes).toString()} h
          {p.budgetUsed !== null ? ` · Budget ${p.budgetUsed} % von ${p.budgetHours?.toString()} h` : ""}{p.hourlyRate ? ` · Satz ${formatMoney(p.hourlyRate.toString())}` : ""}
        </p>
      </div>
      <ErrorBanner message={error} />

      <div className="flex flex-wrap items-end gap-3 text-sm">
        {biller && (
          <form action={bill} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="projectId" value={p.id} />
            <label>Abrechnen bis<input type="date" name="upTo" defaultValue={today} max={today} required className={input} /></label>
            <label>Steuer<select name="taxCodeId" required className={input}>{taxCodes.map((t) => <option key={t.id} value={t.id}>{t.key} ({t.rate.toString()} %)</option>)}</select></label>
            <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Offene Zeiten abrechnen (Rechnungsentwurf)</button>
          </form>
        )}
        {manage && <form action={status}><input type="hidden" name="projectId" value={p.id} /><input type="hidden" name="to" value={p.status === "ACTIVE" ? "CLOSED" : "ACTIVE"} /><button className={secondary}>{p.status === "ACTIVE" ? "Projekt abschließen" : "Projekt wieder öffnen"}</button></form>}
      </div>

      <section className="space-y-2" aria-label="Zeiten">
        <h2 className="font-medium">Zeiten</h2>
        {p.times.length === 0 ? <p className="text-sm text-muted">Noch keine Buchungen.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted"><tr><th className="py-2">Datum</th><th>Person</th><th className="text-right">Stunden</th><th>Notiz</th><th>Status</th><th /></tr></thead>
            <tbody className="divide-y divide-line">
              {p.times.map((t) => (
                <tr key={t.id}>
                  <td className="py-2">{t.workDate.toISOString().slice(0, 10)}</td><td>{t.employeeName}</td>
                  <td className="text-right">{t.kind === "REVERSAL" ? "−" : ""}{minutesToHours(t.minutes).toString()}</td><td>{t.note ?? ""}</td>
                  <td>{t.kind === "REVERSAL" ? "Gegenbuchung" : t.reversed ? "korrigiert" : t.billed ? "abgerechnet" : "offen"}</td>
                  <td>
                    {t.kind === "WORK" && !t.reversed && !t.billed && (
                      <form action={reverse} className="flex items-center gap-1"><input type="hidden" name="projectId" value={p.id} /><input type="hidden" name="timeId" value={t.id} />
                        <input name="reason" required minLength={3} placeholder="Grund" aria-label="Grund der Korrektur" className="w-28 rounded-md border border-line bg-bg px-2 py-0.5" />
                        <button className="rounded-md border border-line px-2 py-0.5">Korrigieren</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-muted">Zeiten sind ein Journal: Korrekturen laufen als Gegenbuchung, abgerechnete Zeiten werden über eine Gutschrift in den Finanzen korrigiert.</p>
      </section>

      {p.billings.length > 0 && (
        <section className="space-y-2" aria-label="Abrechnungen">
          <h2 className="font-medium">Abrechnungen</h2>
          <ul className="divide-y divide-line text-sm">
            {p.billings.map((b) => <li key={b.id} className="flex justify-between py-2"><span>bis {b.upTo.toISOString().slice(0, 10)} · {minutesToHours(b.minutes).toString()} h</span><span>{formatMoney(b.netAmount.toString())} netto · <Link className="text-accent underline" href={`/finance/out/${b.invoiceId}`}>Rechnungsentwurf</Link></span></li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
