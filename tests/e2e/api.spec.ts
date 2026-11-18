import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// REST-API über echtes HTTP: Token anlegen (einmalige Anzeige), lesen, widerrufen. Berechtigungen und Daten prüfen die Integrationstests.
test("API: Token anlegen, nutzen, widerrufen", async ({ page, request }) => {
  await login(page, "admin");
  await page.goto("/settings/api");
  await expect(page.getByRole("heading", { name: "API-Zugänge" })).toBeVisible();
  const name = `e2e-${Date.now()}`;
  await page.getByRole("form", { name: "Token anlegen" }).getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Token anlegen" }).click();
  const shown = page.getByRole("status").locator("code");
  await expect(shown).toHaveText(/^bos_[0-9a-f]{48}$/);
  const token = (await shown.textContent())!;

  expect((await request.get("/api/v1/customers")).status()).toBe(401);
  const ok = await request.get("/api/v1/customers?limit=5", { headers: { authorization: `Bearer ${token}` } });
  expect(ok.status()).toBe(200);
  const body = await ok.json();
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.page.limit).toBe(5);
  expect(JSON.stringify(body)).not.toContain("organizationId");
  expect((await request.get("/api/v1/openapi.json")).status()).toBe(200);
  expect((await request.post("/api/v1/customers", { headers: { authorization: `Bearer ${token}` }, data: {} })).status()).toBe(405); // nur lesend

  await page.reload(); // der Klartext ist nach dem Neuladen nirgends mehr zu sehen
  await expect(page.getByText(token)).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "Widerrufen" }).click();
  await expect(row).toContainText("widerrufen");
  expect((await request.get("/api/v1/customers", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
  await logout(page);

  await login(page, "employee");
  await page.goto("/settings/api");
  await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
  await logout(page);
});
