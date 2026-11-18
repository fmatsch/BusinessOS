import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Analysen: Berichtsliste folgt den Rechten, Diagramm und Tabelle, CSV-Export.
test("Analysen: Berichte, Diagramm, CSV; Rechte begrenzen die Liste", async ({ page }) => {
  await login(page, "admin");
  await page.goto("/analytics");
  await expect(page.getByRole("heading", { name: "Analysen" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Berichte" });
  await expect(nav.getByRole("link", { name: "Umsatz je Monat" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Spesen je Monat" })).toBeVisible();

  await nav.getByRole("link", { name: "Budget und Verbrauch je Kostenstelle" }).click();
  await page.waitForURL(/report=budget/);
  await expect(page.getByRole("heading", { name: /^Budget und Verbrauch/ })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();

  await nav.getByRole("link", { name: "Umsatz je Monat" }).click();
  await page.waitForURL(/report=revenue/);
  await expect(page.getByRole("img", { name: /Umsatz je Monat:/ })).toBeVisible(); // Diagramm mit Textalternative
  await expect(page.getByRole("row")).toHaveCount(13); // Kopf + 12 Monate

  const res = await page.request.get("/analytics/export/revenue?year=2026");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect((await res.text()).startsWith("\uFEFFMonat;Umsatz netto")).toBe(true);
  await logout(page);

  await login(page, "manager");
  await page.goto("/analytics");
  await expect(page.getByRole("navigation", { name: "Berichte" }).getByRole("link", { name: "Umsatz je Monat" })).toHaveCount(0);
  const denied = await page.request.get("/analytics/export/revenue?year=2026");
  expect(denied.status()).toBe(403);
  await logout(page);

  await login(page, "employee");
  await page.goto("/analytics");
  await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
  await logout(page);
});
