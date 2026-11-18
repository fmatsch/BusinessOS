import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Workflows: anlegen, als neue Version ändern, ausschalten; Mitarbeiter ohne Zugriff.
test.describe.serial("Workflows (Browser)", () => {
  const tag = Date.now().toString(36);
  const key = `wf-${tag}`, name = `Große Rechnung ${tag}`;

  test("Workflow anlegen, ändern (neue Version) und ausschalten", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/workflows");
    const f = page.getByRole("form", { name: "Workflow veröffentlichen" });
    await f.getByLabel("Schlüssel").fill(key);
    await f.getByLabel("Name").fill(name);
    await f.getByLabel("Ereignis").selectOption({ label: "Ausgangsrechnung ausgestellt" });
    await f.getByLabel("Feld 1").selectOption("gross");
    await f.getByLabel("Vergleich 1").selectOption("gt");
    await f.getByLabel("Wert 1").fill("5000");
    await f.getByLabel("Empfänger 1").selectOption("ACTOR");
    await f.getByLabel("Titel 1").fill("Rechnung {{number}} über {{gross}} €");
    await f.getByRole("button", { name: "Veröffentlichen" }).click();
    const row = page.getByRole("row").filter({ hasText: key });
    await expect(row).toContainText("Ausgangsrechnung ausgestellt");
    await expect(row).toContainText("gross größer als 5000");
    await expect(row).toContainText("aktiv");

    await row.getByRole("link", { name: "Bearbeiten" }).click();
    await page.waitForURL(/key=/);
    const e = page.getByRole("form", { name: "Workflow veröffentlichen" });
    await e.getByLabel("Wert 1").fill("10000");
    await e.getByRole("button", { name: "Als neue Version veröffentlichen" }).click();
    const r2 = page.getByRole("row").filter({ hasText: key });
    await expect(r2).toContainText("gross größer als 10000");
    await expect(r2.getByRole("cell", { name: "2", exact: true })).toBeVisible();

    await r2.getByRole("button", { name: "Ausschalten" }).click();
    await expect(page.getByRole("row").filter({ hasText: key })).toContainText("aus");
    await expect(page.getByRole("row").filter({ hasText: key }).getByRole("cell", { name: "3", exact: true })).toBeVisible();
    await logout(page);
  });

  test("ungültige Bedingung wird mit Meldung abgewiesen; Mitarbeiter haben keinen Zugriff", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/workflows");
    const f = page.getByRole("form", { name: "Workflow veröffentlichen" });
    await f.getByLabel("Schlüssel").fill(`bad-${tag}`);
    await f.getByLabel("Name").fill("Ungültig");
    await f.getByLabel("Ereignis").selectOption({ label: "Mahnung erstellt" });
    await f.getByLabel("Feld 1").selectOption("gross"); // Feld gehört zu anderen Ereignissen
    await f.getByLabel("Wert 1").fill("1");
    await f.getByLabel("Empfänger 1").selectOption("ACTOR");
    await f.getByLabel("Titel 1").fill("x");
    await f.getByRole("button", { name: "Veröffentlichen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "gibt es bei diesem Ereignis nicht" })).toBeVisible();
    await logout(page);

    await login(page, "employee");
    await page.goto("/workflows");
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    await logout(page);
  });
});
