import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Fertigung: Seiten erreichbar, Rechte begrenzen den Zugriff. Stücklisten, Rückmeldung und Planung prüfen die Integrationstests.
test("Fertigung: Seiten und Rechte", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/production");
  await expect(page.getByRole("heading", { name: "Fertigung", exact: true })).toBeVisible();
  await page.goto("/production/boms");
  await expect(page.getByRole("heading", { name: "Stücklisten" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Stückliste anlegen" })).toBeVisible();
  await page.goto("/production/mrp");
  await expect(page.getByRole("heading", { name: "Bedarfsplanung" })).toBeVisible();
  await logout(page);

  await login(page, "employee");
  await page.goto("/production");
  await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
  await logout(page);
});
