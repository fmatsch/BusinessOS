import Link from "next/link";
import { requireContext } from "@/platform/tenancy/context";
import { can } from "@/platform/authz/authorize";
import { financeOverview } from "@/modules/finance/service";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  const ctx = await requireContext();
  if (!can(ctx, "finance.invoice.read") && !can(ctx, "finance.export.read") && !can(ctx, "finance.master.read")) return <p>Dafür fehlt Ihnen die Berechtigung.</p>;
  const o = can(ctx, "finance.invoice.read") ? await financeOverview(ctx) : { draftIn: 0, approvedIn: 0, draftOut: 0, issuedOut: 0, exports: 0 };
  const { draftIn, approvedIn, draftOut, issuedOut, exports } = o;
  const cards: [string, string, string, string][] = [
    ["/finance/in", "Eingangsrechnungen", `${draftIn} warten auf Freigabe · ${approvedIn} unbezahlt`, "finance.invoice.read"],
    ["/finance/out", "Ausgangsrechnungen", `${draftOut} Entwürfe · ${issuedOut} unbezahlt`, "finance.invoice.read"],
    ["/finance/receivables", "Offene Posten und Mahnwesen", "Alterung, Zahlungserinnerung, Mahnungen als PDF", "finance.invoice.read"],
    ["/finance/export", "Export an die Steuerberatung", `${exports} Läufe bisher`, "finance.export.read"],
    ["/finance/settings", "Einstellungen: Konten, Steuern, Format", "Kontenplan, Steuerkennzeichen, Zuordnung, DATEV/BMD", "finance.master.read"],
  ];
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Finanzen</h1>
        <p className="text-sm text-muted">Belege erfassen und an die Steuerberatung übergeben. Die Bücher führt die Steuerberatung; hier gibt es kein Hauptbuch, keine Bilanz und keine Umsatzsteuer-Voranmeldung.</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.filter(([, , , perm]) => can(ctx, perm as never)).map(([href, title, sub]) => (
          <li key={href} className="rounded-xl border border-line bg-surface p-4">
            <Link className="font-medium text-accent underline" href={href}>{title}</Link>
            <p className="text-sm text-muted">{sub}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
