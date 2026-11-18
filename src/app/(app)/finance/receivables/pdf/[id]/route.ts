import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { getDunningPdf } from "@/modules/finance/receivables";

export const dynamic = "force-dynamic";

/** PDF einer Mahnung. Mandant und Berechtigung werden im Service geprüft. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  try {
    const f = await getDunningPdf(ctx, id);
    return new Response(new Uint8Array(f.bytes), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Keine Berechtigung", { status: 403 });
    if (e instanceof NotFoundError) return new Response("Nicht gefunden", { status: 404 });
    console.error("Dunning PDF failed", e);
    return new Response("Das PDF kann nicht erzeugt werden", { status: 500 });
  }
}
