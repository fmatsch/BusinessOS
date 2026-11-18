import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Vertrieb: Seiten erreichbar, Rechte begrenzen den Zugriff. Auftrag, Lieferung und Abrechnung prüfen die Integrationstests.
test("Aufträge: Seiten und Rechte", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/sales");
  await expect(page.getByRole("heading", { name: "Aufträge und Lieferung" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Auftrag anlegen" })).toBeVisible();
  await logout(page);

  await login(page, "employee");
  await page.goto("/sales");
  await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
  await logout(page);
});
