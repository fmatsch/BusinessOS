"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { LANG_COOKIE } from "@/lib/i18n";
import { auth, signOut } from "@/platform/auth/auth";
import { ORG_COOKIE } from "@/platform/tenancy/context";
import { ForbiddenError } from "@/platform/authz/authorize";

export async function switchOrganization(formData: FormData) {
  const orgId = z.string().min(1).parse(formData.get("organizationId"));
  const userId = (await auth())?.user?.id;
  if (!userId) throw new ForbiddenError("session");
  // Nur Organisationen, in denen der Benutzer Mitglied ist
  const member = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: { id: true },
  });
  if (!member) throw new ForbiddenError("org.switch");
  (await cookies()).set(ORG_COOKIE, orgId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  revalidatePath("/", "layout");
}

export async function setLanguage(formData: FormData) {
  const lang = z.enum(["de", "en"]).parse(formData.get("lang"));
  (await cookies()).set(LANG_COOKIE, lang, { sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  revalidatePath("/", "layout");
}

export async function logout() {
  await signOut({ redirectTo: "/login" });
}
