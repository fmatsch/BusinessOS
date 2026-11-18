import { getOrder } from "@/modules/sales/service";
import { day, iso, withApi } from "../../_lib";

export const dynamic = "force-dynamic";

export function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withApi(req, async (ctx) => {
    const o = await getOrder(ctx, (await params).id);
    return {
      id: o.id, number: o.number, customerId: o.customerId, customerName: o.customerName, reference: o.reference, status: o.status, orderDate: day(o.orderDate), note: o.note, confirmedAt: iso(o.confirmedAt),
      lines: o.lines.map((l) => ({ position: l.position, itemNumber: l.item?.number ?? null, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), shipped: l.shipped.toString(), billed: l.billed.toString() })),
      deliveries: o.deliveries.map((d) => ({ id: d.id, number: d.number, status: d.status, shippedOn: day(d.shippedOn), carrier: d.carrier, trackingNumber: d.trackingNumber })),
    };
  });
}
