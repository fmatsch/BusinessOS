import { requireContext } from "@/platform/tenancy/context";
import { listMyShifts } from "@/modules/roster/service";
import { buildIcs } from "@/modules/roster/ical";

export const dynamic = "force-dynamic";

/** Eigener Dienstplan als Kalenderdatei. Nur für angemeldete Benutzer, nur die eigenen veröffentlichten Schichten. */
export async function GET() {
  const ctx = await requireContext();
  const shifts = await listMyShifts(ctx, new Date(Date.now() - 7 * 86_400_000));
  const body = buildIcs(shifts.map((s) => ({
    uid: `${s.shiftId}-${s.employeeId}@businessos`, start: s.startAt, end: s.endAt, summary: s.label ? `${s.label} (${s.siteName})` : `Dienst ${s.siteName}`, location: s.siteName,
  })));
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="dienstplan.ics"',
      "Cache-Control": "private, no-store",
    },
  });
}
