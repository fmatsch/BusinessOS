import { getCustomerInvoice } from "@/modules/finance/service";
import { day, withApi } from "../../_lib";

export const dynamic = "force-dynamic";

export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApi(req, async (ctx) => {
    const inv = await getCustomerInvoice(ctx, (await params).id);
    const rate = new Map(inv.taxCodes.map((t) => [t.id, t.rate.toString()]));
    return {
      id: inv.id, number: inv.number, kind: inv.kind, status: inv.status, customerNumber: inv.customer.number, customerName: inv.customer.name,
      invoiceDate: day(inv.invoiceDate), dueDate: day(inv.dueDate), currency: inv.currency, netTotal: inv.netTotal.toString(), taxTotal: inv.taxTotal.toString(), grossTotal: inv.grossTotal.toString(), paidOn: day(inv.paidOn), note: inv.note,
      lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), netAmount: l.netAmount.toString(), taxRate: rate.get(l.taxCodeId) ?? null })),
    };
  });
}
