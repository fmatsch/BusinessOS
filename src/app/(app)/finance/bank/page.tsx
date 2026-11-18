import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireContext } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";
import { acceptExactSuggestions, candidatesForLine, ignoreBankLine, importBankStatement, listBankLines, matchBankLine, reopenBankLine, unmatchBankLine, type BankFilter } from "@/modules/finance/bank-service";
import { MAX_BANK_FILE_BYTES } from "@/modules/finance/bank";
import { formatMoney } from "@/lib/money";
import { ErrorBanner, runAction } from "../../action-helpers";

export const dynamic = "force-dynamic";
const BACK = "/finance/bank";
const TABS: [BankFilter, string][] = [["OPEN", "Offen"], ["MATCHED", "Zugeordnet"], ["IGNORED", "Ignoriert"]];

async function upload(fd: FormData) {
  "use server";
  const ctx = await requireContext();
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) redirect(`${BACK}?error=${encodeURIComponent("Bitte eine Datei wählen")}`);
  if (file.size > MAX_BANK_FILE_BYTES) redirect(`${BACK}?error=${encodeURIComponent("Die Datei ist zu groß (höchstens 2 MB)")}`);
  const r = await runAction(BACK, async () => importBankStatement(ctx, { filename: file.name, content: new TextDecoder("utf-8").decode(await file.arrayBuffer()) }));
  revalidatePath(BACK);
  redirect(`${BACK}?imported=${r.created}&skipped=${r.skipped}`);
}
async function match(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => matchBankLine(ctx, String(fd.get("lineId")), String(fd.get("documentId")))); revalidatePath(BACK); }
async function unmatch(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(`${BACK}?tab=MATCHED`, () => unmatchBankLine(ctx, String(fd.get("lineId")))); revalidatePath(BACK); }
async function ignore(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(BACK, () => ignoreBankLine(ctx, String(fd.get("lineId")), String(fd.get("note") ?? ""))); revalidatePath(BACK); }
async function reopen(fd: FormData) { "use server"; const ctx = await requireContext(); await runAction(`${BACK}?tab=IGNORED`, () => reopenBankLine(ctx, String(fd.get("lineId")))); revalidatePath(BACK); }
async function acceptAll() {
  "use server";
  const ctx = await requireContext();
  const r = await runAction(BACK, () => acceptExactSuggestions(ctx));
  revalidatePath(BACK);
  const q = new URLSearchParams({ matched: String(r.matched) });
  if (r.failed.length) q.set("error", r.failed.map((f) => f.error).join(" · "));
  redirect(`${BACK}?${q}`);
}

export default async function BankPage({ searchParams }: { searchParams: Promise<{ error?: string; tab?: string; imported?: string; skipped?: string; matched?: string }> }) {
  const sp = await searchParams;
  const tab: BankFilter = sp.tab === "MATCHED" || sp.tab === "IGNORED" ? sp.tab : "OPEN";
  const ctx = await requireContext();
  let lines;
  try { lines = await listBankLines(ctx, tab); } catch (e) {
    if (e instanceof ForbiddenError) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
    throw e;
  }
  const manual = tab === "OPEN" ? await Promise.all(lines.filter((l) => !l.suggestion).slice(0, 50).map(async (l) => [l.id, await candidatesForLine(ctx, l.id)] as const)) : [];
  const cands = new Map(manual);
  const exact = lines.filter((l) => l.suggestion?.strength === "EXACT").length;
  const input = "rounded-md border border-line bg-bg px-2 py-0.5";

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <p className="text-sm"><Link className="text-accent underline" href="/finance">← Finanzen</Link></p>
        <h1 className="text-2xl font-semibold tracking-tight">Bankabgleich</h1>
        <p className="text-sm text-muted">Kontoauszug (CAMT.053-XML oder CSV) importieren und Zahlungen offenen Rechnungen zuordnen. Eine Zuordnung vermerkt den Beleg mit dem Buchungsdatum als bezahlt. Der Betrag muss genau stimmen; Teilzahlungen und Sammelzahlungen werden nicht automatisch zugeordnet. Es gibt keine Bankanbindung – die Datei laden Sie aus dem Online-Banking herunter.</p>
      </div>
      <ErrorBanner message={sp.error} />
      {sp.imported !== undefined && <p role="status" className="text-sm">{sp.imported} neue Zahlungen importiert, {sp.skipped} bereits bekannte übersprungen.</p>}
      {sp.matched !== undefined && <p role="status" className="text-sm">{sp.matched} Zahlungen zugeordnet.</p>}

      <form action={upload} className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
        <label>Kontoauszug<input type="file" name="file" accept=".xml,.csv,.txt,text/csv,text/xml" required className="mt-1 block" /></label>
        <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-accent-fg">Importieren</button>
      </form>

      <nav aria-label="Status" className="flex gap-4 text-sm">
        {TABS.map(([k, label]) => <Link key={k} href={`${BACK}?tab=${k}`} aria-current={tab === k ? "page" : undefined} className={tab === k ? "font-semibold underline" : "text-accent underline"}>{label}</Link>)}
      </nav>
      {tab === "OPEN" && exact > 0 && <form action={acceptAll}><button className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg">{exact} sichere Vorschläge übernehmen</button></form>}

      {lines.length === 0 ? <p className="text-sm text-muted">Keine Zahlungen.</p> : (
        <table className="w-full text-left text-sm">
          <thead className="text-muted"><tr><th className="py-2">Datum</th><th className="text-right">Betrag</th><th>Gegenseite</th><th>Verwendungszweck</th><th>{tab === "OPEN" ? "Zuordnung" : "Status"}</th></tr></thead>
          <tbody className="divide-y divide-line align-top">
            {lines.map((l) => (
              <tr key={l.id}>
                <td className="py-2">{l.bookingDate.toISOString().slice(0, 10)}</td>
                <td className="text-right">{formatMoney(l.amount.toString(), l.currency)}</td>
                <td>{l.counterpartyName ?? "–"}</td><td className="max-w-xs break-words">{l.reference}</td>
                <td>
                  {tab === "OPEN" && (
                    <div className="space-y-1">
                      {l.suggestion ? (
                        <form action={match} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="lineId" value={l.id} /><input type="hidden" name="documentId" value={l.suggestion.candidate.id} />
                          <span>{l.suggestion.strength === "EXACT" ? "Passt zu" : "Möglicherweise"} {l.suggestion.candidate.numbers[0]} ({l.suggestion.candidate.party})</span>
                          <button className="rounded-md border border-line px-2 py-0.5">Zuordnen</button>
                        </form>
                      ) : (cands.get(l.id) ?? []).length > 0 ? (
                        <form action={match} className="flex flex-wrap items-center gap-2">
                          <input type="hidden" name="lineId" value={l.id} />
                          <select name="documentId" aria-label="Beleg wählen" className={input}>{(cands.get(l.id) ?? []).map((c) => <option key={c.id} value={c.id}>{c.numbers[0]} · {c.party}</option>)}</select>
                          <button className="rounded-md border border-line px-2 py-0.5">Zuordnen</button>
                        </form>
                      ) : <span className="text-muted">kein Beleg mit diesem Betrag</span>}
                      <form action={ignore} className="flex items-center gap-2"><input type="hidden" name="lineId" value={l.id} />
                        <input name="note" required minLength={3} placeholder="Grund" aria-label="Grund zum Ignorieren" className={input} /><button className="rounded-md border border-line px-2 py-0.5">Ignorieren</button></form>
                    </div>
                  )}
                  {tab === "MATCHED" && (
                    <form action={unmatch} className="flex items-center gap-2"><input type="hidden" name="lineId" value={l.id} /><span>{l.matchKind === "CUSTOMER_INVOICE" ? "Kundenrechnung" : "Eingangsrechnung"}</span><button className="rounded-md border border-line px-2 py-0.5">Zuordnung lösen</button></form>
                  )}
                  {tab === "IGNORED" && (
                    <form action={reopen} className="flex items-center gap-2"><input type="hidden" name="lineId" value={l.id} /><span>{l.note}</span><button className="rounded-md border border-line px-2 py-0.5">Wieder öffnen</button></form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
