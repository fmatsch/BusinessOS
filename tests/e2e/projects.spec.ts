import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// Projekte: Anlegen (Führung/Inhaber) → Zeit buchen (Mitarbeiter, ohne Einblick in den Satz) → abrechnen als Rechnungsentwurf.
test.describe.serial("Projekte (Browser)", () => {
  const tag = Date.now().toString(36).toUpperCase();
  const customerNo = `PR${tag}`, customerName = `Projekt Kunde ${tag}`, taxOut = `P${tag}`, name = `Relaunch ${tag}`;
  let projectUrl = "";

  const form = (page: Page, button: string) => page.locator("form").filter({ has: page.getByRole("button", { name: button, exact: true }) });

  test("Vorbereitung: Steuerkennzeichen, Kunde und Projekt", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/finance/settings");
    const f = form(page, "Steuerkennzeichen anlegen");
    await f.getByLabel("Schlüssel", { exact: true }).fill(taxOut);
    await f.getByLabel("Bezeichnung").fill("Umsatzsteuer 20 %");
    await f.getByLabel("Satz (%)").fill("20");
    await f.getByLabel("Art").selectOption("OUTPUT");
    await f.getByRole("button", { name: "Steuerkennzeichen anlegen" }).click();
    await expect(page.getByRole("cell", { name: taxOut, exact: true })).toBeVisible();
    const cf = form(page, "Kunde anlegen");
    await cf.getByLabel("Nummer").fill(customerNo);
    await cf.getByLabel("Name").fill(customerName);
    await cf.getByRole("button", { name: "Kunde anlegen" }).click();
    await expect(page.getByText(customerName).first()).toBeVisible();

    await page.goto("/projects");
    const pf = form(page, "Projekt anlegen");
    await pf.getByLabel("Name").fill(name);
    await pf.locator('select[name="customerId"]').selectOption({ label: `${customerNo} ${customerName}` });
    await pf.getByLabel("Stundensatz (netto)").fill("100");
    await pf.getByLabel("Stundenbudget").fill("10");
    await pf.getByRole("button", { name: "Projekt anlegen" }).click();
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
    await logout(page);
  });

  test("Mitarbeiter bucht Zeit und sieht den Verrechnungssatz nicht", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/projects");
    const bf = form(page, "Buchen");
    const value = await bf.locator('select[name="projectId"] option').filter({ hasText: name }).getAttribute("value");
    await bf.locator('select[name="projectId"]').selectOption(value as string);
    await bf.getByLabel("Stunden").fill("2,5");
    await bf.getByLabel("Notiz").fill("Konzept");
    await bf.getByRole("button", { name: "Buchen" }).click();
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText("2.5");
    await expect(row).not.toContainText("100,00"); // kein Einblick in den Satz
    await row.getByRole("link").click();
    await page.waitForURL(/\/projects\/[^/]+$/);
    projectUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("button", { name: /abrechnen/ })).toHaveCount(0);
    await expect(page.getByRole("row").filter({ hasText: "Konzept" })).toContainText("offen");
    await logout(page);
  });

  test("Abrechnen erzeugt den Rechnungsentwurf; die Zeit ist danach gesperrt", async ({ page }) => {
    await login(page, "admin");
    await page.goto(projectUrl);
    await expect(page.getByText(/gebucht 2.5 h/)).toBeVisible();
    await page.getByRole("button", { name: /Offene Zeiten abrechnen/ }).click();
    await expect(page).toHaveURL(/\/finance\/out\//);
    await expect(page.getByRole("heading", { name: new RegExp(`Entwurf · ${customerName}`) })).toBeVisible();
    await expect(page.getByText("300,00").first()).toBeVisible(); // 2,5 h × 100 + 20 % USt
    await page.goto(projectUrl);
    await expect(page.getByRole("row").filter({ hasText: "Konzept" })).toContainText("abgerechnet");
    await expect(page.getByRole("button", { name: "Korrigieren" })).toHaveCount(0);
    await logout(page);
  });
});
