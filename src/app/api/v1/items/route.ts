import { listItems } from "@/modules/inventory/service";
import { paginate, withApi } from "../_lib";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withApi(req, async (ctx, url) => {
    const rows = await listItems(ctx);
    return paginate(rows.map((i) => ({ id: i.id, number: i.number, name: i.name, unit: i.unit, onHand: i.onHand.toString(), reorderLevel: i.reorderLevel?.toString() ?? null, tracking: i.tracking, valuationMethod: i.valuationMethod, active: i.active })), url);
  });
}
