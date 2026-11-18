import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { createCostCenter, listCostCenters, listDepartments } from "@/modules/masterdata/service";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  try {
    await createCostCenter(ctx, {
      code: formData.get("code"),
      name: formData.get("name"),
      departmentId: formData.get("departmentId") || null,
    });
  } catch (e) {
    if (e instanceof ZodError) return;
    throw e;
  }
  revalidatePath("/cost-centers");
}

export default async function CostCentersPage() {
  const ctx = await requireContext();
  if (!can(ctx, "master.costcenter.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const [centers, departments] = await Promise.all([
    listCostCenters(ctx),
    can(ctx, "master.department.read") ? listDepartments(ctx) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Kostenstellen</h1>
      {can(ctx, "master.costcenter.write") && (
        <form action={create} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <label>Code<input name="code" required maxLength={20} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
          <label>Name<input name="name" required maxLength={120} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
          <label>Abteilung
            <select name="departmentId" className="mt-1 block rounded-md border border-line bg-bg px-2 py-1">
              <option value="">–</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">Anlegen</button>
        </form>
      )}
      {centers.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Code</th><th>Name</th><th>Abteilung</th></tr></thead>
          <tbody className="divide-y divide-line">
            {centers.map((c) => (
              <tr key={c.id}><td className="py-2">{c.code}</td><td>{c.name}</td><td>{c.department?.name ?? "–"}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
