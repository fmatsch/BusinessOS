import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Hauptbuch: Seiten erreichbar, Berichte rendern, Rechte begrenzen den Zugriff. Die Buchungslogik prüfen die Integrationstests.
test("Hauptbuch: Seiten, Berichte und Rechte", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/finance/ledger");
  await expect(page.getByRole("heading", { name: "Hauptbuch" })).toBeVisible();
  await page.getByRole("link", { name: "Einrichtung" }).first().click();
  await expect(page.getByRole("heading", { name: "Hauptbuch: Einrichtung" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Einschalten" })).toBeVisible();

  await page.goto("/finance/ledger/reports?tab=bs");
  await expect(page.getByRole("heading", { name: "Auswertungen" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Berichte" }).getByRole("link", { name: "GuV" })).toBeVisible();
  await page.goto("/finance/ledger/reports?tab=pl");
  await expect(page.getByRole("heading", { name: "Auswertungen" })).toBeVisible();
  await page.goto("/finance/ledger/periods");
  await expect(page.getByRole("heading", { name: /^Perioden/ })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(13); // Kopf + 12 Monate
  await logout(page);

  await login(page, "employee");
  await page.goto("/finance/ledger");
  await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
  await logout(page);
});
