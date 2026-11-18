import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { getCustomerInvoiceEInvoice } from "@/modules/finance/service";

export const dynamic = "force-dynamic";

/** E-Rechnung (UBL, Peppol BIS 3.0) einer ausgestellten Ausgangsrechnung. Fehlen Angaben, wird ihre Liste mit Status 409 ausgegeben. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  try {
    const f = await getCustomerInvoiceEInvoice(ctx, id);
    if (!f.xml) return new Response(`Die E-Rechnung kann noch nicht erzeugt werden:\n- ${f.problems.join("\n- ")}`, { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return new Response(f.xml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Keine Berechtigung", { status: 403 });
    if (e instanceof NotFoundError) return new Response("Nicht gefunden", { status: 404 });
    if (e instanceof ConflictError) return new Response(e.message, { status: 409 });
    console.error("E-Invoice failed", e);
    return new Response("Die E-Rechnung kann nicht erzeugt werden", { status: 500 });
  }
}
