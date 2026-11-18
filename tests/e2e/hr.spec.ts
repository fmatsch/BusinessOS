import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// Personal und Abwesenheiten über drei Rollen: Personalwesen (Inhaber), Führungskraft, Mitarbeiter.
test.describe.serial("HR-Basis Ende-zu-Ende (Browser)", () => {
  const note = `E2E-${Date.now().toString(36)}`;
  let employeeUrl = "";

  async function expectNotification(page: Page, text: RegExp) {
    await page.goto("/notifications");
    await expect
      .poll(async () => { await page.reload(); return page.getByText(text).count(); }, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(0);
  }

  test("Personalwesen bucht Urlaub dazu und pflegt persönliche Angaben", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/hr");
    await page.getByRole("link", { name: /Mitarbeiter Max/ }).click();
    await page.waitForURL(/\/hr\/[^/]+$/);
    employeeUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { name: "Max Mitarbeiter" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Beschäftigung" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Persönliche Angaben" })).toBeVisible();

    await page.getByLabel("Art").last().selectOption("ADJUSTMENT");
    await page.getByLabel("Tage").fill("5");
    await page.getByLabel("Hinweis").last().fill(note);
    await page.getByRole("button", { name: "Buchen" }).click();
    await expect(page.getByRole("cell", { name: note })).toBeVisible();

    await page.getByLabel("Telefon").fill(`${note}-TEL`);
    await page.getByRole("button", { name: "Speichern" }).last().click();
    await expect(page.getByLabel("Telefon")).toHaveValue(`${note}-TEL`);
    await logout(page);
  });

  test("Mitarbeiter beantragt Urlaub", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/absences");
    await expect(page.getByText(/verfügbar \d/)).toBeVisible();

    // zufälliger Zeitraum im laufenden Jahr; bei Überschneidung mit früheren Läufen erneut versuchen
    let requested = false;
    for (let attempt = 0; attempt < 8 && !requested; attempt++) {
      const d = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 5 + 7 * Math.floor(Math.random() * 48)));
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
      const from = d.toISOString().slice(0, 10);
      d.setUTCDate(d.getUTCDate() + 1);
      const to = d.toISOString().slice(0, 10);
      await page.getByLabel("Art").selectOption("VACATION");
      await page.getByLabel("Von").fill(from);
      await page.getByLabel("Bis").fill(to);
      await page.getByRole("button", { name: "Beantragen" }).click();
      await page.waitForLoadState("networkidle");
      requested = (await page.getByRole("alert").filter({ hasText: /überschneidet|keine Arbeitstage/ }).count()) === 0
        && (await page.getByRole("row", { name: new RegExp(from) }).count()) > 0;
      if (!requested) await page.goto("/absences");
    }
    expect(requested).toBe(true);
    await expect(page.getByRole("row", { name: /offen/ }).first()).toBeVisible();
    await logout(page);
  });

  test("Führungskraft wird benachrichtigt und genehmigt", async ({ page }) => {
    await login(page, "manager");
    await expectNotification(page, /Abwesenheitsantrag: Max Mitarbeiter/);
    await page.goto("/absences");
    await expect(page.getByRole("heading", { name: "Wartet auf Ihre Entscheidung" })).toBeVisible();
    const item = page.getByRole("listitem").filter({ hasText: "Mitarbeiter Max" }).first();
    await item.getByRole("button", { name: "Genehmigen" }).click();
    await expect(page.getByRole("heading", { name: "Mein Team" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Mitarbeiter Max.*genehmigt/ }).first()).toBeVisible();
    await logout(page);
  });

  test("Mitarbeiter sieht die Genehmigung und sein Konto", async ({ page }) => {
    await login(page, "employee");
    await expectNotification(page, /Urlaub genehmigt/);
    await page.goto("/absences");
    await expect(page.getByRole("row", { name: /genehmigt/ }).first()).toBeVisible();
    await expect(page.getByText(/verbraucht [1-9]/)).toBeVisible();
    await logout(page);
  });

  test("Datenschutz: Führungskraft sieht keine Vertrags- und Privatdaten, Mitarbeiter nur die eigenen", async ({ page }) => {
    await login(page, "manager");
    await page.goto(employeeUrl);
    await expect(page.getByRole("heading", { name: "Max Mitarbeiter" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Beschäftigung" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Persönliche Angaben" })).toHaveCount(0);
    await expect(page.getByText(`${note}-TEL`)).toHaveCount(0);
    await logout(page);

    await login(page, "employee");
    await page.goto("/hr"); // ohne Verzeichnisrecht: direkt zum eigenen Profil
    await expect(page).toHaveURL(new RegExp(`${employeeUrl}$`));
    await expect(page.getByText(`${note}-TEL`).or(page.getByLabel("Telefon"))).toBeVisible();
    await logout(page);
  });

  test("Audit-Log enthält Lesezugriffe auf sensible Daten, aber keine Inhalte", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/audit");
    await expect(page.getByRole("cell", { name: "employee.read_sensitive", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "leave.entry", exact: true }).first()).toBeVisible();
    await expect(page.getByText(`${note}-TEL`)).toHaveCount(0);
    await logout(page);
  });
});
