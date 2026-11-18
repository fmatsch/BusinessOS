import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Qualität und Instandhaltung: Seiten erreichbar, Rechte begrenzen den Zugriff. Abläufe prüfen die Integrationstests.
test("Qualität und Instandhaltung: Seiten und Rechte", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/quality");
  await expect(page.getByRole("heading", { name: "Qualität", exact: true })).toBeVisible();
  await page.goto("/quality/plans");
  await expect(page.getByRole("heading", { name: "Prüfpläne", exact: true })).toBeVisible();
  await page.goto("/quality/nc");
  await expect(page.getByRole("heading", { name: "Abweichungen", exact: true })).toBeVisible();
  await page.goto("/maintenance");
  await expect(page.getByRole("heading", { name: "Instandhaltung", exact: true })).toBeVisible();
  await expect(page.getByRole("form", { name: "Störung melden" })).toBeVisible();
  await page.goto("/maintenance/plans");
  await expect(page.getByRole("heading", { name: "Objekte und Wartungspläne" })).toBeVisible();
  await logout(page);

  await login(page, "employee");
  await page.goto("/quality");
  await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
  await page.goto("/maintenance"); // Mitarbeiter dürfen Störungen melden, aber keine Aufträge sehen
  await expect(page.getByRole("form", { name: "Störung melden" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Aufträge" })).toHaveCount(0);
  await logout(page);
});
