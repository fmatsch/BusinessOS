import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { LANG_COOKIE, t, type TKey } from "@/lib/i18n";

const MODULES = ["inventory", "workflows", "analytics"];

export default async function Planned({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  if (!MODULES.includes(module)) notFound();
  const locale = (await cookies()).get(LANG_COOKIE)?.value === "en" ? "en" : "de";
  return (
    <div className="max-w-xl space-y-3">
      <h1 className="text-2xl font-semibold tracking-tight">{t(locale, `nav.${module}` as TKey)}</h1>
      <span className="rounded-full bg-surface px-3 py-1 text-xs text-muted ring-1 ring-line">{t(locale, "planned")}</span>
      <p className="text-muted">{t(locale, "planned.text")}</p>
    </div>
  );
}
