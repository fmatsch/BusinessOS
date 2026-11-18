import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Lager: Beschaffung bis Wareneingang → Artikel anlegen → einbuchen → entnehmen → Inventur.
test.describe.serial("Lager (Browser)", () => {
  const s = Date.now().toString(36).toUpperCase();
  const cc = `LG${s}`, supplier = `LL${s}`, desc = `Palette ${s}`, itemNo = `ART${s}`;
  let itemUrl = "";

  test("Beschaffung bis zum Wareneingang", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/cost-centers");
    await page.getByLabel("Code").fill(cc);
    await page.getByLabel("Name").fill(`Lager ${s}`);
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("cell", { name: cc, exact: true })).toBeVisible();
    await page.goto("/suppliers");
    await page.getByLabel("Nummer").fill(supplier);
    await page.getByLabel("Name").fill(`Lieferant ${s}`);
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("cell", { name: supplier, exact: true })).toBeVisible();
    await logout(page);

    await login(page, "employee");
    await page.goto("/procurement");
    await page.getByLabel("Titel").fill(`Ware ${s}`);
    await page.getByLabel("Kostenstelle (optional)").selectOption({ label: `${cc} · Lager ${s}` });
    await page.getByLabel("Beschreibung 1").fill(desc);
    await page.getByLabel("Menge 1").fill("5");
    await page.getByLabel("Stückpreis 1").fill("20");
    await page.getByRole("button", { name: "Einreichen" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`Ware ${s}`) })).toBeVisible();
    const req = new URL(page.url()).pathname;
    await logout(page);

    await login(page, "manager");
    await page.goto(req);
    await page.getByRole("button", { name: /Freigeben/ }).click();
    await expect(page.getByText("Status: Freigegeben")).toBeVisible();
    await logout(page);

    await login(page, "admin");
    await page.goto(req);
    await page.getByLabel("Lieferant").selectOption({ label: `${supplier} · Lieferant ${s}` });
    await page.getByRole("button", { name: "Bestellen" }).click();
    await expect(page.getByText("Status: Bestellt")).toBeVisible();
    const section = page.getByRole("region", { name: /^Wareneingang PO-/ });
    await section.getByPlaceholder("bis 5").fill("3");
    await section.getByRole("button", { name: "Wareneingang buchen" }).click();
    await expect(page.getByRole("heading", { name: /teilgeliefert/ })).toBeVisible();
    await logout(page);
  });

  test("Artikel anlegen, Wareneingang einbuchen, entnehmen, Inventur", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/inventory");
    const f = page.locator("form").filter({ has: page.getByRole("button", { name: "Anlegen", exact: true }) });
    await f.getByLabel("Artikelnummer").fill(itemNo);
    await f.getByLabel("Bezeichnung").fill(`Holzträger ${s}`);
    await f.getByLabel("Mindestbestand").fill("2");
    await f.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("row").filter({ hasText: itemNo })).toBeVisible();

    await page.getByRole("link", { name: "Wareneingänge einbuchen" }).click();
    const row = page.getByRole("row").filter({ hasText: desc });
    await expect(row).toContainText("3");
    const value = await row.locator("select[name=itemId] option").filter({ hasText: itemNo }).getAttribute("value");
    await row.locator("select[name=itemId]").selectOption(value as string);
    await row.getByRole("button", { name: "Einbuchen" }).click();
    await expect(page.getByRole("row").filter({ hasText: desc })).toHaveCount(0); // nur einmal

    await page.goto("/inventory");
    await page.getByRole("link", { name: itemNo }).click();
    await page.waitForURL(/\/inventory\/[^/]+$/);
    itemUrl = new URL(page.url()).pathname;
    await expect(page.getByText(/Bestand 3 Stk/)).toBeVisible();

    const issue = page.locator("form").filter({ has: page.getByRole("button", { name: "Entnehmen" }) });
    await issue.getByLabel("Menge").fill("4");
    await issue.getByRole("button", { name: "Entnehmen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Nicht genug Bestand" })).toBeVisible();
    await issue.getByLabel("Menge").fill("2");
    await issue.getByRole("button", { name: "Entnehmen" }).click();
    await expect(page.getByText(/Bestand 1 Stk/)).toBeVisible();

    const inv = page.locator("form").filter({ has: page.getByRole("button", { name: "Korrektur buchen" }) });
    await inv.getByLabel("Gezählter Bestand").fill("2");
    await inv.getByLabel("Grund").fill("Inventur: eine Palette gefunden");
    await inv.getByRole("button", { name: "Korrektur buchen" }).click();
    await expect(page.getByText(/Bestand 2 Stk/)).toBeVisible();
    await page.goto("/inventory/locations");
    await expect(page.getByRole("heading", { name: "Lagerorte" })).toBeVisible();
    await page.goto("/inventory/valuation");
    await expect(page.getByRole("heading", { name: "Lagerbewertung" })).toBeVisible();
    await logout(page);
  });

  test("Mitarbeiter haben keinen Zugriff; Führungskraft darf lesen und buchen", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/inventory");
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    await logout(page);
    await login(page, "manager");
    await page.goto(itemUrl);
    await expect(page.getByRole("heading", { name: new RegExp(itemNo) })).toBeVisible();
    await expect(page.getByRole("button", { name: "Entnehmen" })).toBeVisible();
    await page.goto("/inventory");
    await expect(page.getByRole("button", { name: "Anlegen" })).toHaveCount(0); // anlegen nur Finanzen/Inhaber
    await logout(page);
  });
});
