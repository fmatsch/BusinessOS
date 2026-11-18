import Link from "next/link";
import type { getEmployeeTime } from "@/modules/time/service";

export type TimeView = Awaited<ReturnType<typeof getEmployeeTime>>;

/** Minuten als Std:Min, mit Vorzeichen bei Salden. */
export function fmtMin(n: number, signed = false) {
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  const a = Math.abs(n);
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")} h`;
}

export function parseMonth(raw: string | undefined, tz: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(raw ?? "");
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]) };
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  return { year: Number(p.find((x) => x.type === "year")!.value), month: Number(p.find((x) => x.type === "month")!.value) };
}

export const ymKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
export function shiftMonth(y: number, m: number, d: number) { const t = y * 12 + (m - 1) + d; return { year: Math.floor(t / 12), month: (t % 12) + 1 }; }

export function MonthNav({ base, year, month }: { base: string; year: number; month: number }) {
  const prev = shiftMonth(year, month, -1), next = shiftMonth(year, month, 1);
  return (
    <nav aria-label="Monat wählen" className="flex items-center gap-3 text-sm">
      <Link className="rounded-md border border-line px-2 py-1" href={`${base}?month=${ymKey(prev.year, prev.month)}`}>← {ymKey(prev.year, prev.month)}</Link>
      <strong>{ymKey(year, month)}</strong>
      <Link className="rounded-md border border-line px-2 py-1" href={`${base}?month=${ymKey(next.year, next.month)}`}>{ymKey(next.year, next.month)} →</Link>
    </nav>
  );
}

export const PERIOD_LABEL: Record<string, string> = { OPEN: "offen", SUBMITTED: "eingereicht", APPROVED: "freigegeben (gesperrt)" };

export function Summary({ v }: { v: TimeView }) {
  const s = v.summary;
  const items: [string, string][] = [
    ["Ist", fmtMin(s.workedMinutes)], ["Soll", fmtMin(s.targetMinutes)], ["Saldo Monat", fmtMin(s.deltaMinutes, true)], ["Zeitkonto gesamt", fmtMin(v.balance, true)],
  ];
  return (
    <section className="space-y-3">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map(([k, val]) => (
          <div key={k} className="rounded-xl border border-line bg-surface p-4"><dt className="text-sm text-muted">{k}</dt><dd className="text-xl font-semibold">{val}</dd></div>
        ))}
      </dl>
      <p className="text-sm text-muted">
        Davon Nacht {fmtMin(s.categories.night)} · Sonntag {fmtMin(s.categories.sunday)} · Feiertag {fmtMin(s.categories.holiday)} · Mehrzeit {fmtMin(s.categories.overtime)}.
        Status des Monats: <strong>{PERIOD_LABEL[v.period?.status ?? "OPEN"]}</strong>.
      </p>
    </section>
  );
}

export function Hints({ v }: { v: TimeView }) {
  const hints = [...new Map(v.summary.hints.map((h) => [`${h.code}:${h.message}`, h])).values()];
  const flagged = v.summary.days.filter((d) => d.flag);
  if (hints.length === 0 && flagged.length === 0) return null;
  return (
    <section aria-label="Hinweise" className="space-y-1 rounded-xl border border-line bg-surface p-4 text-sm">
      <h2 className="font-medium">Hinweise zur Prüfung</h2>
      <ul className="list-disc pl-5">
        {hints.map((h) => <li key={`${h.code}:${h.message}`}>{h.message}</li>)}
        {flagged.map((d) => <li key={d.date}>{d.date}: {d.flag === "MISSING" ? `Keine Buchung, geplant ${fmtMin(d.planned)}` : `Abweichung vom Plan: geplant ${fmtMin(d.planned)}, gebucht ${fmtMin(d.actual)}`}</li>)}
      </ul>
    </section>
  );
}

export function EntryTable({ v, actions }: { v: TimeView; actions?: (e: TimeView["entries"][number]) => React.ReactNode }) {
  const tz = v.tz;
  const t = (d: Date) => d.toLocaleString("de-AT", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const src: Record<string, string> = { CLOCK: "Stempeluhr", MANUAL: "Nachtrag", CORRECTION: "Korrektur", REVERSAL: "Gegenbuchung" };
  if (v.entries.length === 0) return <p className="text-sm text-muted">Noch keine Einträge.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-muted"><tr><th className="py-2">Beginn</th><th>Ende</th><th>Pause</th><th>Netto</th><th>Quelle</th><th>Status</th><th /></tr></thead>
      <tbody className="divide-y divide-line">
        {v.entries.map((e) => {
          const net = Math.round((e.endAt.getTime() - e.startAt.getTime()) / 60_000) - e.breakMinutes;
          const active = e.kind === "WORK" && !e.reversedBy;
          return (
            <tr key={e.id} className={active ? "" : "text-muted"}>
              <td className="py-2">{t(e.startAt)}</td><td>{t(e.endAt)}</td><td>{e.breakMinutes} min</td><td>{e.kind === "REVERSAL" ? `−${fmtMin(net)}` : fmtMin(net)}</td>
              <td>{src[e.source]}{e.reason ? ` · ${e.reason}` : ""}</td>
              <td>{e.kind === "REVERSAL" ? "Storno" : e.reversedBy ? "ersetzt/storniert" : "gültig"}</td>
              <td>{active && actions?.(e)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function DayTable({ v }: { v: TimeView }) {
  if (v.summary.days.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="font-medium">Plan und Ist je Tag</h2>
      <table className="w-full text-left text-sm">
        <thead className="text-muted"><tr><th className="py-2">Datum</th><th>Geplant</th><th>Gebucht</th><th>Differenz</th><th>Hinweis</th></tr></thead>
        <tbody className="divide-y divide-line">
          {v.summary.days.map((d) => (
            <tr key={d.date}><td className="py-2">{d.date}</td><td>{fmtMin(d.planned)}</td><td>{fmtMin(d.actual)}</td><td>{fmtMin(d.delta, true)}</td>
              <td>{d.absence ? "Abwesenheit" : d.flag === "MISSING" ? "keine Buchung" : d.flag === "DEVIATION" ? "Abweichung" : ""}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
