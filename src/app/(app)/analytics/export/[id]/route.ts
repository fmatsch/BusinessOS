import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { exportReportCsv } from "@/modules/analytics/service";

export const dynamic = "force-dynamic";

/** CSV-Export eines Berichts. Rechte und Audit-Eintrag im Service. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const year = Number(new URL(req.url).searchParams.get("year")) || new Date().getUTCFullYear();
  const ctx = await requireContext();
  try {
    const f = await exportReportCsv(ctx, id, year);
    return new Response(f.csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${f.filename.replace(/[^\w.-]/g, "_")}"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Keine Berechtigung", { status: 403 });
    if (e instanceof NotFoundError) return new Response("Nicht gefunden", { status: 404 });
    if (e instanceof ConflictError) return new Response(e.message, { status: 400 });
    console.error("Analytics export failed", e);
    return new Response("Der Export ist nicht möglich", { status: 500 });
  }
}
