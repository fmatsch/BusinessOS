import { listCustomerInvoices } from "@/modules/finance/service";
import { day, paginate, withApi } from "../_lib";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withApi(req, async (ctx, url) => {
    let rows = await listCustomerInvoices(ctx);
    const status = url.searchParams.get("status");
    if (status) rows = rows.filter((r) => r.status === status);
    return paginate(rows.map((r) => ({ id: r.id, number: r.number, customerNumber: r.customer.number, customerName: r.customer.name, kind: r.kind, status: r.status, invoiceDate: day(r.invoiceDate), dueDate: day(r.dueDate), currency: r.currency, netTotal: r.netTotal.toString(), taxTotal: r.taxTotal.toString(), grossTotal: r.grossTotal.toString(), paidOn: day(r.paidOn) })), url);
  });
}
