import Link from "next/link";
import { cookies } from "next/headers";
import { requireContext } from "@/platform/tenancy/context";
import { unreadCount } from "@/platform/notifications/service";
import { LANG_COOKIE, t, type Locale } from "@/lib/i18n";
import { logout, setLanguage, switchOrganization } from "./actions";

const NAV = [
  { href: "/", key: "nav.dashboard", live: true },
  { href: "/departments", key: "nav.departments", live: true },
  { href: "/cost-centers", key: "nav.costcenters", live: true },
  { href: "/budgets", key: "nav.budgets", live: true },
  { href: "/finance", key: "nav.finance", live: true },
  { href: "/hr", key: "nav.hr", live: true },
  { href: "/absences", key: "nav.absences", live: true },
  { href: "/roster", key: "nav.roster", live: true },
  { href: "/time", key: "nav.time", live: true },
  { href: "/time/team", key: "nav.timeTeam", live: true },
  { href: "/payroll", key: "nav.payroll", live: true },
  { href: "/expenses", key: "nav.expenses", live: true },
  { href: "/procurement", key: "nav.procurement", live: true },
  { href: "/suppliers", key: "nav.suppliers", live: true },
  { href: "/inventory", key: "nav.inventory", live: true },
  { href: "/projects", key: "nav.projects", live: true },
  { href: "/crm", key: "nav.crm", live: true },
  { href: "/planned/workflows", key: "nav.workflows" },
  { href: "/planned/analytics", key: "nav.analytics" },
  { href: "/copilot", key: "nav.copilot", live: true },
  { href: "/audit", key: "nav.audit", live: true },
  { href: "/settings/approvals", key: "nav.approvals", live: true },
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const unread = await unreadCount(ctx);
  const locale: Locale = (await cookies()).get(LANG_COOKIE)?.value === "en" ? "en" : "de";

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-line bg-surface p-4">
        <div className="mb-6 text-lg font-semibold tracking-tight">BusinessOS</div>
        <nav aria-label="Hauptnavigation" className="flex flex-col gap-1 text-sm">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}
              className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-bg">
              <span className={"live" in item ? "" : "text-muted"}>{t(locale, item.key)}</span>
              {!("live" in item) && (
                <span className="rounded-full bg-bg px-2 text-xs text-muted">{t(locale, "planned")}</span>
              )}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-6 py-3 text-sm">
          <form action={switchOrganization} className="flex items-center gap-2">
            <label htmlFor="org" className="text-muted">{t(locale, "org")}</label>
            <select id="org" name="organizationId" defaultValue={ctx.organizationId}
              className="rounded-md border border-line bg-bg px-2 py-1">
              {ctx.organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button className="rounded-md border border-line px-2 py-1">OK</button>
          </form>
          <div className="flex items-center gap-3">
            <form action={setLanguage} className="flex gap-1">
              <button name="lang" value="de" className="rounded px-2 py-1 hover:bg-bg" aria-pressed={locale === "de"}>DE</button>
              <button name="lang" value="en" className="rounded px-2 py-1 hover:bg-bg" aria-pressed={locale === "en"}>EN</button>
            </form>
            <Link href="/notifications" className="rounded px-2 py-1 hover:bg-bg">
              Benachrichtigungen{unread > 0 && <span className="ml-1 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-fg" data-testid="unread-count">{unread}<span className="sr-only"> ungelesen</span></span>}
            </Link>
            <span className="text-muted">{ctx.userName}</span>
            <form action={logout}><button className="rounded-md border border-line px-2 py-1">{t(locale, "logout")}</button></form>
          </div>
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  );
}
