import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { getExportFile } from "@/modules/payroll/service";

export const dynamic = "force-dynamic";

/** Download eines Exportlaufs (nur mit Leserecht; Hash wird geprüft, der Abruf wird im Audit-Log protokolliert). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  try {
    const { fileName, bytes, encoding } = await getExportFile(ctx, id);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": `text/csv; charset=${encoding === "latin1" ? "iso-8859-1" : "utf-8"}`,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Keine Berechtigung", { status: 403 });
    if (e instanceof NotFoundError) return new Response("Nicht gefunden", { status: 404 });
    console.error("Payroll download failed", e);
    return new Response("Der Download ist nicht möglich", { status: 500 });
  }
}
