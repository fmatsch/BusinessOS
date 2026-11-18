import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { createDepartment, listDepartments } from "@/modules/masterdata/service";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  try {
    await createDepartment(ctx, {
      code: formData.get("code"),
      name: formData.get("name"),
      parentId: formData.get("parentId") || null,
    });
  } catch (e) {
    if (e instanceof ZodError) return; // Formular-Validierung via HTML-Attribute; Details im Server-Log
    throw e;
  }
  revalidatePath("/departments");
}

export default async function DepartmentsPage() {
  const ctx = await requireContext();
  if (!can(ctx, "master.department.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const departments = await listDepartments(ctx);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Abteilungen</h1>
      {can(ctx, "master.department.write") && (
        <form action={create} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
          <label>Code<input name="code" required maxLength={20} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
          <label>Name<input name="name" required maxLength={120} className="mt-1 block rounded-md border border-line bg-bg px-2 py-1" /></label>
          <label>Übergeordnet
            <select name="parentId" className="mt-1 block rounded-md border border-line bg-bg px-2 py-1">
              <option value="">–</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button>
        </form>
      )}
      {departments.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Code</th><th>Name</th><th>Übergeordnet</th><th>Kostenstellen</th></tr></thead>
          <tbody className="divide-y divide-line">
            {departments.map((d) => (
              <tr key={d.id}><td className="py-2">{d.code}</td><td>{d.name}</td><td>{d.parent?.name ?? "–"}</td><td>{d._count.costCenters}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
