import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { createEmployee, getSelfEmployee, listEmployees, listLinkableUsers } from "@/modules/hr/service";
import { listDepartments } from "@/modules/masterdata/service";
import { ErrorBanner, runAction } from "../action-helpers";

export const dynamic = "force-dynamic";

async function create(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  const e = await runAction("/hr", () =>
    createEmployee(ctx, {
      number: formData.get("number"), firstName: formData.get("firstName"), lastName: formData.get("lastName"),
      email: formData.get("email"), jobTitle: formData.get("jobTitle"),
      departmentId: formData.get("departmentId") || null, managerId: formData.get("managerId") || null, userId: formData.get("userId") || null,
    }),
  );
  revalidatePath("/hr");
  redirect(`/hr/${e.id}`);
}

export default async function HrPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  if (!can(ctx, "hr.employee.read")) {
    const me = await getSelfEmployee(ctx);
    if (me) redirect(`/hr/${me.id}`); // ohne Verzeichnisrecht: nur das eigene Profil
    return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  }
  const writer = can(ctx, "hr.employee.write");
  const [employees, departments, users] = await Promise.all([
    listEmployees(ctx),
    writer && can(ctx, "master.department.read") ? listDepartments(ctx) : Promise.resolve([]),
    writer ? listLinkableUsers(ctx) : Promise.resolve([]),
  ]);
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Personal</h1>
      <ErrorBanner message={error} />
      {writer && (
        <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-4">
          <label>Personalnr.<input name="number" required maxLength={20} className={input} /></label>
          <label>Vorname<input name="firstName" required maxLength={80} className={input} /></label>
          <label>Nachname<input name="lastName" required maxLength={80} className={input} /></label>
          <label>E-Mail<input name="email" type="email" maxLength={200} className={input} /></label>
          <label>Position<input name="jobTitle" maxLength={80} className={input} /></label>
          <label>Abteilung
            <select name="departmentId" className={input}><option value="">–</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          </label>
          <label>Führungskraft
            <select name="managerId" className={input}><option value="">–</option>{employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.lastName} {e.firstName}</option>)}</select>
          </label>
          <label>Benutzerkonto
            <select name="userId" className={input}><option value="">–</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select>
          </label>
          <div className="sm:col-span-4"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Mitarbeiter anlegen</button></div>
        </form>
      )}
      {employees.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Nr.</th><th>Name</th><th>Position</th><th>Abteilung</th><th>Führungskraft</th><th>Status</th></tr></thead>
          <tbody className="divide-y divide-line">
            {employees.map((e) => (
              <tr key={e.id}>
                <td className="py-2">{e.number}</td>
                <td><Link className="text-accent underline" href={`/hr/${e.id}`}>{e.lastName} {e.firstName}</Link></td>
                <td>{e.jobTitle ?? "–"}</td><td>{e.department?.name ?? "–"}</td>
                <td>{e.manager ? `${e.manager.lastName} ${e.manager.firstName}` : "–"}</td>
                <td>{e.active ? "aktiv" : "inaktiv"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
