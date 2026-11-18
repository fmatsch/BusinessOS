import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { createSupplier, listSuppliers } from "@/modules/procurement/service";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await runAction("/suppliers", () =>
    createSupplier(ctx, { number: formData.get("number"), name: formData.get("name"), email: formData.get("email") }),
  );
  revalidatePath("/suppliers");
}

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "procurement.supplier.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const suppliers = await listSuppliers(ctx);
  const input = "mt-1 block rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Lieferanten</h1>
      <ErrorBanner message={error} />
      {can(ctx, "procurement.supplier.write") && (
        <form action={create} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <label>Nummer<input name="number" required maxLength={20} className={input} /></label>
          <label>Name<input name="name" required maxLength={120} className={input} /></label>
          <label>E-Mail<input name="email" type="email" maxLength={200} className={input} /></label>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">Anlegen</button>
        </form>
      )}
      {suppliers.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Nummer</th><th>Name</th><th>E-Mail</th></tr></thead>
          <tbody className="divide-y divide-line">
            {suppliers.map((s) => <tr key={s.id}><td className="py-2">{s.number}</td><td>{s.name}</td><td>{s.email ?? "–"}</td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}
