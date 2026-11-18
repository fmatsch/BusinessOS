import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { getAccountingExportFile } from "@/modules/finance/export";

export const dynamic = "force-dynamic";

/** Download eines Exportlaufs (Buchungsdatei oder Belegpaket) nur mit Leserecht; Hash wird geprüft, Abruf wird protokolliert. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const part = new URL(req.url).searchParams.get("part") === "package" ? "package" : "data";
  const ctx = await requireContext();
  try {
    const f = await getAccountingExportFile(ctx, id, part);
    return new Response(new Uint8Array(f.bytes), {
      headers: {
        "Content-Type": part === "data" ? "text/csv; charset=windows-1252" : f.mime,
        "Content-Disposition": `attachment; filename="${f.name}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Keine Berechtigung", { status: 403 });
    if (e instanceof NotFoundError) return new Response("Nicht gefunden", { status: 404 });
    console.error("Finance export download failed", e);
    return new Response("Der Download ist nicht möglich", { status: 500 });
  }
}
