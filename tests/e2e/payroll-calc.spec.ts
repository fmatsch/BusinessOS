import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Lohnabrechnung: Seiten erreichbar, Rechte begrenzen den Zugriff. Die Berechnung prüfen die Einheits- und Integrationstests.
test("Lohnabrechnung: Seiten und Rechte", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/payroll/calc");
  await expect(page.getByRole("heading", { name: "Lohnabrechnung (Österreich)" })).toBeVisible();
  await expect(page.getByText("Die mitgelieferten Werte sind ein Entwurf")).toBeVisible();
  await page.goto("/payroll/payslips");
  await expect(page.getByRole("heading", { name: "Meine Lohnabrechnungen" })).toBeVisible();
  await logout(page);

  await login(page, "employee");
  await page.goto("/payroll/calc");
  await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
  await page.goto("/payroll/payslips");
  await expect(page.getByRole("heading", { name: "Meine Lohnabrechnungen" })).toBeVisible();
  await logout(page);
});
