import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Wareneingang: Anforderung → Freigabe → Bestellung → Teillieferung → Korrektur; Rechnungserfassung bietet die Bestellung zum Abgleich an.
test.describe.serial("Wareneingang (Browser)", () => {
  const s = Date.now().toString(36).toUpperCase();
  const cc = `W${s}`;
  const supplier = `WL${s}`;
  const title = `Regale ${s}`;
  let url = "";

  test("Anforderung wird eingereicht, freigegeben und bestellt", async ({ page }) => {
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
    await page.getByLabel("Titel").fill(title);
    await page.getByLabel("Kostenstelle (optional)").selectOption({ label: `${cc} · Lager ${s}` });
    await page.getByLabel("Beschreibung 1").fill("Regal");
    await page.getByLabel("Menge 1").fill("4");
    await page.getByLabel("Stückpreis 1").fill("150");
    await page.getByRole("button", { name: "Einreichen" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(title) })).toBeVisible();
    url = new URL(page.url()).pathname;
    // Mitarbeiter sieht keinen Wareneingang
    await expect(page.getByText(/Wareneingang/)).toHaveCount(0);
    await logout(page);

    await login(page, "manager");
    await page.goto(url);
    await page.getByRole("button", { name: /Freigeben/ }).click();
    await expect(page.getByText("Status: Freigegeben")).toBeVisible();
    await logout(page);

    await login(page, "admin");
    await page.goto(url);
    await page.getByLabel("Lieferant").selectOption({ label: `${supplier} · Lieferant ${s}` });
    await page.getByRole("button", { name: "Bestellen" }).click();
    await expect(page.getByText("Status: Bestellt")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Wareneingang PO-\d{4}-\d{4} · nichts geliefert/ })).toBeVisible();
    await logout(page);
  });

  test("Teillieferung, Überlieferung wird abgelehnt, Korrektur per Gegenbuchung", async ({ page }) => {
    await login(page, "manager");
    await page.goto(url);
    const section = page.getByRole("region", { name: /^Wareneingang PO-/ });
    await section.getByPlaceholder("bis 4").fill("5");
    await section.getByRole("button", { name: "Wareneingang buchen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "nur noch 4 offen" })).toBeVisible();

    await section.getByPlaceholder("bis 4").fill("1");
    await section.getByRole("button", { name: "Wareneingang buchen" }).click();
    await expect(page.getByRole("heading", { name: /teilgeliefert/ })).toBeVisible();
    await expect(section.getByRole("row", { name: /Regal/ })).toContainText("4");

    await section.getByLabel("Grund der Korrektur").fill("Falsch gebucht");
    await section.getByRole("button", { name: "Korrigieren" }).click();
    await expect(page.getByRole("heading", { name: /nichts geliefert/ })).toBeVisible();
    await expect(section.getByText("(korrigiert)")).toBeVisible();
    await expect(section.getByText("(Gegenbuchung)")).toBeVisible();
    await logout(page);
  });

  test("Eingangsrechnung bietet die Bestellung zum Abgleich an", async ({ page }) => {
    await login(page, "finance");
    await page.goto("/finance/in");
    const f = page.locator("form").filter({ has: page.getByRole("button", { name: "Rechnung erfassen", exact: true }) });
    await expect(f.locator('select[name="purchaseOrderId"]')).toContainText(`Lieferant ${s}`);
    await logout(page);
  });
});
