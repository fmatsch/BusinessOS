import { listOrders } from "@/modules/sales/service";
import { day, paginate, withApi } from "../_lib";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withApi(req, async (ctx, url) => {
    let rows = await listOrders(ctx);
    const status = url.searchParams.get("status");
    if (status) rows = rows.filter((o) => o.status === status);
    return paginate(rows.map((o) => ({ id: o.id, number: o.number, customerId: o.customerId, customerName: o.customerName, reference: o.reference, status: o.status, orderDate: day(o.orderDate), net: o.net.toString() })), url);
  });
}
