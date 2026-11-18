import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { can, ForbiddenError } from "@/platform/authz/authorize";
import { createLocation, listLocations, setLocationActive } from "@/modules/inventory/service";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/inventory/locations";

async function create(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => createLocation(ctx, { code: fd.get("code"), name: fd.get("name") })); revalidatePath(BACK); }
async function toggle(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => setLocationActive(ctx, String(fd.get("id")), fd.get("active") === "1")); revalidatePath(BACK); }

export default async function LocationsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const ctx = await requireContext();
  let locations;
  try { locations = await listLocations(ctx); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manage = can(ctx, "inventory.manage");
  const input = "mt-1 block w-full rounded-md border border-line bg-bg px-2 py-1";
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/inventory">← Lager</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Lagerorte</h1>
        <p className="text-sm text-muted">Bestand, der vor den Lagerorten gebucht wurde, steht unter „Ohne Lagerort“ und lässt sich umbuchen. Deaktivieren ist nur ohne Bestand möglich.</p>
      </div>
      <ErrorBanner message={error} />
      {manage && (
        <form action={create} className="grid gap-3 rounded-xl border border-line bg-surface p-4 text-sm sm:grid-cols-3" aria-label="Lagerort anlegen">
          <label>Code<input name="code" required maxLength={20} className={input} /></label>
          <label className="sm:col-span-2">Name<input name="name" required maxLength={80} className={input} /></label>
          <div className="sm:col-span-3"><button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Anlegen</button></div>
        </form>
      )}
      {locations.length === 0 ? <p className="text-sm text-muted">Noch keine Lagerorte.</p> : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Lagerorte</caption>
          <thead className="text-muted"><tr><th scope="col" className="py-2">Code</th><th scope="col">Name</th><th scope="col">Status</th>{manage && <th />}</tr></thead>
          <tbody className="divide-y divide-line">
            {locations.map((l) => (
              <tr key={l.id}><td className="py-1.5">{l.code}</td><td>{l.name}</td><td>{l.active ? "aktiv" : "inaktiv"}</td>
                {manage && <td><form action={toggle}><input type="hidden" name="id" value={l.id} /><input type="hidden" name="active" value={l.active ? "0" : "1"} /><button className="rounded-md border border-line px-2 py-0.5">{l.active ? "Deaktivieren" : "Aktivieren"}</button></form></td>}</tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
