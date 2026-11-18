import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { getCustomerInvoicePdf } from "@/modules/finance/service";

export const dynamic = "force-dynamic";

/** PDF einer ausgestellten Ausgangsrechnung. Nur Lesen, Mandant und Berechtigung werden im Service geprüft. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  try {
    const f = await getCustomerInvoicePdf(ctx, id);
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Keine Berechtigung", { status: 403 });
    if (e instanceof NotFoundError) return new Response("Nicht gefunden", { status: 404 });
    if (e instanceof ConflictError) return new Response(e.message, { status: 409 });
    console.error("Invoice PDF failed", e);
    return new Response("Das PDF kann nicht erzeugt werden", { status: 500 });
  }
}
