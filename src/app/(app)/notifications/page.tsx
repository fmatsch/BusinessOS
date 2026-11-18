import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireContext } from "@/platform/tenancy/context";
import { listNotifications, markAllRead, markRead } from "@/platform/notifications/service";

export const dynamic = "force-dynamic";

async function readOne(formData: FormData) {
  "use server";
  const ctx = await requireContext();
  await markRead(ctx, String(formData.get("id")));
  revalidatePath("/", "layout");
}
async function readAll() {
  "use server";
  const ctx = await requireContext();
  await markAllRead(ctx);
  revalidatePath("/", "layout");
}

export default async function NotificationsPage() {
  const ctx = await requireContext();
  const items = await listNotifications(ctx);
  const unread = items.filter((n) => !n.readAt).length;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Benachrichtigungen</h1>
        {unread > 0 && (
          <form action={readAll}><button className="rounded-md border border-line px-3 py-1.5 text-sm">Alle als gelesen markieren</button></form>
        )}
      </div>
      {items.length === 0 ? <p className="text-sm text-muted">Noch keine Einträge.</p> : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-sm">
          {items.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div>
                <p className={n.readAt ? "text-muted" : "font-medium"}>
                  {n.href ? <Link className="underline" href={n.href}>{n.title}</Link> : n.title}
                  {!n.readAt && <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-fg">neu</span>}
                </p>
                {n.body && <p className="text-muted">{n.body}</p>}
                <time className="text-xs text-muted" dateTime={n.createdAt.toISOString()}>
                  {n.createdAt.toLocaleString("de-AT", { timeZone: "Europe/Vienna" })}
                </time>
              </div>
              {!n.readAt && (
                <form action={readOne}><input type="hidden" name="id" value={n.id} /><button className="rounded-md border border-line px-2 py-1 text-xs">Gelesen</button></form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
