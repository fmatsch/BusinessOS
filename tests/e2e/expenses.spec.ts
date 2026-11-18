import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// Spesen: Mitarbeiter erfasst mit Beleg und reicht ein → direkte Führungskraft gibt frei → Finanzen vermerkt die Auszahlung.
test.describe.serial("Reisekosten und Spesen (Browser)", () => {
  const tag = Date.now().toString(36).toUpperCase();
  const title = `Kundenreise ${tag}`;
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  let url = "";

  const form = (page: Page, button: string) => page.locator("form").filter({ has: page.getByRole("button", { name: button, exact: true }) });

  test("Mitarbeiter erfasst Abrechnung mit Beleg und reicht sie ein", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/expenses");
    const f = form(page, "Anlegen");
    await f.getByLabel("Titel").fill(title);
    await f.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(title) })).toBeVisible();
    url = new URL(page.url()).pathname;
    const lf = form(page, "Hinzufügen");
    await lf.getByLabel("Beschreibung").fill("Bahnticket Wien–Graz");
    await lf.getByLabel(/^Betrag/).fill("89,90");
    await lf.locator('input[type="file"]').setInputFiles({ name: "ticket.pdf", mimeType: "application/pdf", buffer: pdf });
    await lf.getByRole("button", { name: "Hinzufügen" }).click();
    const row = page.getByRole("row").filter({ hasText: "Bahnticket" });
    await expect(row).toContainText("89,90");
    const receipt = await row.getByRole("link", { name: "ansehen" }).getAttribute("href");
    const res = await page.request.get(receipt as string);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    await page.getByRole("button", { name: "Einreichen" }).click();
    await expect(page.getByRole("heading", { name: /^EX-\d{4}-\d{4}/ })).toBeVisible();
    await expect(page.getByText(/Status: wartet auf Freigabe/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Hinzufügen" })).toHaveCount(0); // eingereicht: nicht mehr änderbar
    await logout(page);
  });

  test("Führungskraft gibt frei, Finanzen vermerkt die Auszahlung", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/expenses");
    const item = page.getByRole("listitem").filter({ hasText: title });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Freigeben" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
    await logout(page);

    await login(page, "finance");
    await page.goto(url);
    await expect(page.getByText(/Status: freigegeben/)).toBeVisible();
    await page.getByRole("button", { name: "Als ausbezahlt vermerken" }).click();
    await expect(page.getByText(/Status: ausbezahlt/)).toBeVisible();
    await logout(page);
  });

  test("Inhaber sieht alle Abrechnungen, die Person sieht den Status", async ({ page }) => {
    await login(page, "admin"); // Inhaber ohne Teamzuordnung, aber mit expense.read_all
    await page.goto(url);
    await expect(page.getByRole("heading", { name: /^EX-/ })).toBeVisible();
    await logout(page);
    await login(page, "employee");
    await page.goto("/expenses?scope=mine");
    await expect(page.getByRole("row").filter({ hasText: title })).toContainText("ausbezahlt");
    await logout(page);
  });
});
