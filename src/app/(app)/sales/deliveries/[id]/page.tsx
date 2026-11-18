import Link from "next/link";
import { notFound } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { NotFoundError } from "@/platform/errors";
import { getDeliveryNote } from "@/modules/sales/service";

export const dynamic = "force-dynamic";

/** Lieferschein (ohne Preise) – im Browser über „Drucken“ als PDF speicherbar. */
export default async function DeliveryNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  let note;
  try { note = await getDeliveryNote(ctx, id); } catch (e) {
    if (e instanceof NotFoundError) notFound();
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm print:hidden"><Link className="text-accent underline" href={`/sales/${note.orderId}`}>← Auftrag</Link></p>
      <h1 className="text-2xl font-semibold tracking-tight">Lieferschein {note.number ?? "(Entwurf)"}</h1>
      {note.status === "CANCELLED" && <p role="status" className="font-medium">Storniert{note.cancelReason ? `: ${note.cancelReason}` : ""}</p>}
      <dl className="grid grid-cols-2 gap-1 text-sm">
        <dt className="text-muted">Kunde</dt><dd>{note.customer?.name ?? "–"}</dd>
        <dt className="text-muted">Anschrift</dt><dd>{[note.customer?.street, [note.customer?.zip, note.customer?.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || "–"}</dd>
        <dt className="text-muted">Auftrag</dt><dd>{note.order.number}{note.order.reference ? ` · ${note.order.reference}` : ""}</dd>
        <dt className="text-muted">Versanddatum</dt><dd>{note.shippedOn ? note.shippedOn.toISOString().slice(0, 10) : "–"}</dd>
        <dt className="text-muted">Spediteur / Sendung</dt><dd>{[note.carrier, note.trackingNumber].filter(Boolean).join(" · ") || "–"}</dd>
      </dl>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Gelieferte Positionen</caption>
        <thead className="text-muted"><tr><th scope="col" className="py-2">Pos.</th><th scope="col">Artikel</th><th scope="col">Bezeichnung</th><th scope="col" className="text-right">Menge</th><th scope="col">Charge / Seriennummern</th></tr></thead>
        <tbody className="divide-y divide-line">
          {note.rows.map((r) => (
            <tr key={r.id}><td className="py-1.5">{r.position}</td><td>{r.itemNumber ?? "–"}</td><td>{r.description}</td><td className="text-right">{r.quantity.toString()} {r.unit}</td><td>{[r.batchNumber, r.serials?.split(/\r?\n/).filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</td></tr>
          ))}
        </tbody>
      </table>
      {note.note && <p className="text-sm">{note.note}</p>}
    </div>
  );
}
