import { listCustomers } from "@/modules/finance/service";
import { paginate, withApi } from "../_lib";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return withApi(req, async (ctx, url) => {
    const rows = await listCustomers(ctx);
    return paginate(rows.map((c) => ({ id: c.id, number: c.number, name: c.name, street: c.street, zip: c.zip, city: c.city, country: c.country, uid: c.uid, paymentTermsDays: c.paymentTermsDays, einvoiceEndpoint: c.einvoiceEndpoint, active: c.active })), url);
  });
}
