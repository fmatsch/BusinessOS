import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/platform/auth/auth";
import { db } from "@/lib/db";
import type { Ctx } from "@/platform/authz/authorize";
import type { Permission } from "@/platform/authz/permissions";

export const ORG_COOKIE = "bos_org";

export interface AppContext extends Ctx {
  userName: string;
  organizationName: string;
  currency: string;
  timeZone: string;
  organizations: { id: string; name: string }[];
}

/**
 * Ermittelt Benutzer + aktive Organisation. Die Mitgliedschaft wird bei jedem Aufruf
 * aus der Datenbank geprüft – das Cookie ist nur eine Auswahl, nie ein Berechtigungsnachweis.
 */
export async function requireContext(): Promise<AppContext> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const memberships = await db.organizationMembership.findMany({
    where: { userId, user: { active: true } },
    include: {
      user: { select: { name: true, sessionVersion: true } },
      organization: true,
      role: { include: { permissions: { include: { permission: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (memberships.length === 0) redirect("/login");
  // Sitzungen vor einem Passwortwechsel/-reset sind ungültig
  const sv = (session.user as { sv?: number }).sv ?? 0;
  if (memberships[0]!.user.sessionVersion !== sv) redirect("/login");

  const wanted = (await cookies()).get(ORG_COOKIE)?.value;
  const active = memberships.find((m) => m.organizationId === wanted) ?? memberships[0]!;

  return {
    userId,
    organizationId: active.organizationId,
    permissions: new Set(active.role.permissions.map((rp) => rp.permission.key as Permission)),
    userName: active.user.name,
    organizationName: active.organization.name,
    currency: active.organization.currency,
    timeZone: active.organization.timeZone,
    organizations: memberships.map((m) => ({ id: m.organizationId, name: m.organization.name })),
  };
}
