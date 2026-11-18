import { expect, test } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { base32Decode, hotp, stepOf } from "../../src/platform/auth/totp";
import { login, logout, PASSWORD, USERS } from "./helpers";

// Zwei-Faktor-Anmeldung und Passwort-Reset über die echte Oberfläche – mit einem eigens angelegten Benutzer, damit die übrigen Szenarien unberührt bleiben.
const db = new PrismaClient();
const email = `sicherheit-${Date.now()}@demo.example`;
const code = (secret: string, offset = 0) => hotp(base32Decode(secret.replace(/\s+/g, "")), stepOf(Date.now()) + offset);

test.describe.configure({ mode: "serial" });

test.describe("Sicherheit (Browser)", () => {
  let userId = "";

  test.beforeAll(async () => {
    const admin = await db.user.findUniqueOrThrow({ where: { email: USERS.admin }, include: { memberships: true } });
    const orgId = admin.memberships[0]!.organizationId;
    const role = await db.role.findFirstOrThrow({ where: { organizationId: orgId, key: "employee" } });
    const user = await db.user.create({ data: { email, name: "Sicherheit Test", passwordHash: await bcrypt.hash(PASSWORD, 4) } });
    userId = user.id;
    await db.organizationMembership.create({ data: { userId, organizationId: orgId, roleId: role.id } });
  });

  test.afterAll(async () => {
    await db.passwordResetToken.deleteMany({ where: { userId } });
    await db.userMfa.deleteMany({ where: { userId } });
    await db.auditLog.deleteMany({ where: { entityType: "User", entityId: userId } });
    await db.organizationMembership.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  async function loginAs(page: import("@playwright/test").Page, password: string, otp?: string) {
    await page.goto("/login");
    await page.getByLabel("E-Mail").fill(email);
    await page.getByLabel(/^Passwort/).fill(password);
    if (otp) await page.getByLabel(/Bestätigungscode/).fill(otp);
    await page.getByRole("button", { name: "Anmelden" }).click();
  }

  test("Zwei-Faktor einrichten, damit anmelden, falschen Code abweisen", async ({ page }) => {
    await loginAs(page, PASSWORD);
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/settings/security");
    await page.getByRole("button", { name: "Einrichten" }).click();
    const secret = (await page.locator("code").first().textContent())!;
    await expect(page.getByText("Geheimer Schlüssel")).toBeVisible();
    await page.getByRole("form", { name: "Einrichtung bestätigen" }).getByLabel("Code aus der App").fill("000000");
    await page.getByRole("button", { name: "Bestätigen und aktivieren" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Code stimmt nicht/ })).toBeVisible();
    await page.getByRole("form", { name: "Einrichtung bestätigen" }).getByLabel("Code aus der App").fill(code(secret));
    await page.getByRole("button", { name: "Bestätigen und aktivieren" }).click();
    await expect(page.getByText(/Wiederherstellungscodes – jeder gilt einmal/)).toBeVisible();
    expect(await page.locator("li.font-mono, ul.font-mono li").count()).toBe(10);
    await logout(page);

    // ohne Code: Hinweis; mit falschem Code: Fehler; mit richtigem Code: angemeldet
    await loginAs(page, PASSWORD);
    await expect(page.getByRole("alert").filter({ hasText: /Bestätigungscode/ })).toBeVisible();
    await loginAs(page, PASSWORD, "111111");
    await expect(page.getByRole("alert").filter({ hasText: /Anmeldung fehlgeschlagen/ })).toBeVisible();
    await loginAs(page, PASSWORD, code(secret, 1)); // der nächste Zeitschritt (der vom Einrichten ist verbraucht)
    await expect(page).toHaveURL(/\/$/);
    await logout(page);
    await db.user.update({ where: { id: userId }, data: { active: true } });
  });

  test("Inhaber setzt das Gerät zurück und erzeugt einen Link; Passwort per Link ändern beendet alte Sitzungen", async ({ page, browser }) => {
    // eine zweite, bereits angemeldete Sitzung der Person (ohne Zwei-Faktor, damit der Test unabhängig bleibt)
    await db.userMfa.deleteMany({ where: { userId } });
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto("http://localhost:3100/login");
    await otherPage.getByLabel("E-Mail").fill(email);
    await otherPage.getByLabel(/^Passwort/).fill(PASSWORD);
    await otherPage.getByRole("button", { name: "Anmelden" }).click();
    await expect(otherPage).toHaveURL(/\/$/);

    await login(page, "admin");
    await page.goto("/settings/security");
    await expect(page.getByRole("heading", { name: "Mitglieder" })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: email });
    await row.getByRole("button", { name: /Passwort-Link für .* erzeugen/ }).click();
    const link = (await row.getByRole("status").locator("code").textContent())!;
    expect(link).toMatch(/\/reset\/[A-Za-z0-9_-]{43}$/);
    await logout(page);

    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Neues Passwort" })).toBeVisible();
    await page.getByLabel("Neues Passwort (mindestens 12 Zeichen)").fill("kurz");
    await page.getByLabel("Wiederholen").fill("kurz");
    await page.getByRole("button", { name: "Passwort speichern" }).click(); // Browser-Mindestlänge verhindert das Absenden
    await page.getByLabel("Neues Passwort (mindestens 12 Zeichen)").fill("Passwort1234");
    await page.getByLabel("Wiederholen").fill("Passwort1234");
    await page.getByRole("button", { name: "Passwort speichern" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /verbreitet/ })).toBeVisible();
    await page.getByLabel("Neues Passwort (mindestens 12 Zeichen)").fill("ein-ganz-neues-Passwort-31");
    await page.getByLabel("Wiederholen").fill("ein-ganz-neues-Passwort-31");
    await page.getByRole("button", { name: "Passwort speichern" }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);
    await expect(page.getByRole("status").filter({ hasText: /Passwort wurde geändert/ })).toBeVisible();

    // Link nur einmal verwendbar
    await page.goto(link);
    await expect(page.getByRole("alert").filter({ hasText: /ungültig oder abgelaufen/ })).toBeVisible();
    // die frühere Sitzung ist beendet
    await otherPage.goto("http://localhost:3100/hr");
    await expect(otherPage).toHaveURL(/\/login/);
    await other.close();
    // altes Passwort geht nicht mehr, neues schon
    await loginAs(page, PASSWORD);
    await expect(page.getByRole("alert").filter({ hasText: /Anmeldung fehlgeschlagen/ })).toBeVisible();
    await loginAs(page, "ein-ganz-neues-Passwort-31");
    await expect(page).toHaveURL(/\/$/);
    await logout(page);
  });

  test("Passwort vergessen: ohne E-Mail-Versand klarer Hinweis, Antwort verrät keine Konten", async ({ page }) => {
    await page.goto("/forgot");
    await expect(page.getByRole("heading", { name: "Passwort vergessen" })).toBeVisible();
    // Auf dem Test-Server ist kein SMTP eingerichtet
    await expect(page.getByText(/E-Mail-Versand ist auf diesem Server nicht eingerichtet/)).toBeVisible();
    await expect(page.getByRole("form")).toHaveCount(0);
  });
});
