import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { getFile } from "@/modules/finance/service";

export const dynamic = "force-dynamic";

/** Belegdatei ansehen. Der Typ kommt aus der Inhaltsprüfung beim Upload; Auslieferung als Anhang mit nosniff und restriktiver CSP. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  try {
    const f = await getFile(ctx, id);
    return new Response(new Uint8Array(f.data), {
      headers: {
        "Content-Type": f.mime,
        "Content-Disposition": `inline; filename="${f.name.replace(/"/g, "")}"`,
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Keine Berechtigung", { status: 403 });
    if (e instanceof NotFoundError) return new Response("Nicht gefunden", { status: 404 });
    console.error("Finance file download failed", e);
    return new Response("Der Download ist nicht möglich", { status: 500 });
  }
}
