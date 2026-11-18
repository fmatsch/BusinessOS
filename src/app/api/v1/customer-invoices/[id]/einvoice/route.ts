import { getCustomerInvoiceEInvoice } from "@/modules/finance/service";
import { apiError, withApi } from "../../../_lib";

export const dynamic = "force-dynamic";

/** E-Rechnung (UBL, Peppol BIS 3.0). Fehlen Angaben, antwortet die API mit 422 und der Liste. */
export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApi(req, async (ctx) => {
    const f = await getCustomerInvoiceEInvoice(ctx, (await params).id);
    if (!f.xml) return apiError(422, "einvoice_incomplete", `Die E-Rechnung kann noch nicht erzeugt werden: ${f.problems.join("; ")}`);
    return new Response(f.xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"` } });
  });
}
