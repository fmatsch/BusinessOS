import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { readPolicy, publishPolicy } from "@/platform/approvals/policy";
import { APPROVER_PERMISSIONS as ALL_APPROVER_PERMISSIONS } from "@/platform/approvals/engine";

const APPROVER_PERMISSIONS = ALL_APPROVER_PERMISSIONS.filter((p) => p.startsWith("procurement."));
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const ROWS = 3;
const PERM_LABEL: Record<string, string> = {
  "procurement.request.approve": "Führungskraft (Beschaffung freigeben)",
  "procurement.request.approve_finance": "Finanzen (Beschaffung freigeben)",
};

async function publish(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const steps = Array.from({ length: ROWS }, (_, i) => ({
    label: String(formData.get(`label${i}`) ?? "").trim(),
    key: String(formData.get(`key${i}`) ?? "").trim().toUpperCase(),
    permission: formData.get(`perm${i}`),
    minAmount: String(formData.get(`min${i}`) ?? "").trim().replace(",", ".") || undefined,
  })).filter((s) => s.label !== "" || s.key !== "");
  await runAction("/settings/approvals", () => publishPolicy(ctx, steps));
  revalidatePath("/settings/approvals");
}

export default async function ApprovalSettings({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "org.settings.manage")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const { policy, versions } = await readPolicy(ctx);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Freigaberegeln: Bestellanforderungen</h1>
      <p className="text-sm text-muted">
        Aktuell gilt Version {policy.version}. Eine neue Version gilt nur für neu eingereichte Anforderungen; laufende Vorgänge behalten ihre Schritte.
        Ein Schritt mit Mindestbetrag ist nur nötig, wenn der Gesamtbetrag darüber liegt. Der erste Schritt gilt immer.
      </p>
      <ErrorBanner message={error} />
      <form action={publish} className="space-y-3 rounded-xl border border-line bg-surface p-4 text-sm">
        {Array.from({ length: ROWS }, (_, i) => {
          const s = policy.steps[i];
          return (
            <fieldset key={i} className="grid gap-2 sm:grid-cols-4">
              <legend className="mb-1 font-medium">Schritt {i + 1}{i > 0 ? " (optional)" : ""}</legend>
              <label>Bezeichnung<input name={`label${i}`} defaultValue={s?.label} maxLength={60} required={i === 0} className={input} /></label>
              <label>Schlüssel<input name={`key${i}`} defaultValue={s?.key} maxLength={30} required={i === 0} className={input} /></label>
              <label>Berechtigung
                <select name={`perm${i}`} defaultValue={s?.permission ?? APPROVER_PERMISSIONS[0]} className={input}>
                  {APPROVER_PERMISSIONS.map((p) => <option key={p} value={p}>{PERM_LABEL[p]}</option>)}
                </select>
              </label>
              <label>Nur über Betrag ({ctx.currency})<input name={`min${i}`} defaultValue={s?.minAmount} inputMode="decimal" disabled={i === 0} className={input} /></label>
            </fieldset>
          );
        })}
        <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Neue Version veröffentlichen</button>
      </form>
      <section>
        <h2 className="mb-2 font-medium">Versionen</h2>
        <ul className="text-sm text-muted">
          {versions.map((v) => <li key={v.id}>Version {v.version} · {v.createdAt.toLocaleString("de-AT", { timeZone: "Europe/Vienna" })}</li>)}
        </ul>
      </section>
    </div>
  );
}
