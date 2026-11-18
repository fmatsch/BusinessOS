/** iCalendar-Export (RFC 5545) für „Mein Dienstplan". Zeiten werden in UTC ausgegeben, dadurch gibt es keine Zeitzonenprobleme. */

export interface IcsShift {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string | null;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Zeilen auf höchstens 75 Oktette kürzen (Fortsetzungszeilen beginnen mit einem Leerzeichen). */
export function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length === 0 ? 75 : 74)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function buildIcs(shifts: IcsShift[], now = new Date(), calName = "Mein Dienstplan"): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BusinessOS//Dienstplan//DE", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(calName)}`];
  for (const s of shifts) {
    lines.push("BEGIN:VEVENT", `UID:${s.uid}`, `DTSTAMP:${stamp(now)}`, `DTSTART:${stamp(s.start)}`, `DTEND:${stamp(s.end)}`, `SUMMARY:${esc(s.summary)}`);
    if (s.location) lines.push(`LOCATION:${esc(s.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
