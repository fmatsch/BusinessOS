import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Automatische WCAG-2-A/AA-Prüfung (axe-core). Deckt nur einen Teil der Barrierefreiheit ab – ersetzt keinen manuellen Test.
const pages = ["/", "/departments", "/cost-centers", "/budgets", "/suppliers", "/procurement", "/audit", "/copilot", "/notifications", "/settings/approvals", "/hr", "/absences", "/roster", "/roster/settings", "/time", "/time/team", "/payroll", "/finance", "/finance/in", "/finance/out", "/crm", "/crm/quotes", "/projects", "/workflows", "/analytics", "/analytics?report=budget", "/expenses", "/inventory", "/inventory/receipts", "/finance/ledger", "/finance/ledger/setup", "/finance/ledger/reports?tab=bs", "/finance/ledger/periods", "/finance/ledger/assets", "/finance/bank", "/finance/receivables", "/finance/recurring", "/finance/export", "/finance/settings"];

async function scan(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("Login-Seite hat keine WCAG-A/AA-Verstöße", async ({ page }) => {
  await page.goto("/login");
  expect(await scan(page)).toEqual([]);
});

test("angemeldete Seiten haben keine WCAG-A/AA-Verstöße (hell und dunkel)", async ({ page }) => {
  test.setTimeout(180_000); // 23 Seiten in zwei Farbschemata
  await login(page, "admin");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of pages) {
      await page.goto(path);
      await expect(page.locator("h1").first()).toBeVisible();
      expect(await scan(page), `${path} (${scheme})`).toEqual([]);
    }
  }
});

test("Mitarbeiterprofil hat keine WCAG-A/AA-Verstöße", async ({ page }) => {
  await login(page, "admin");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/hr");
    await page.getByRole("link", { name: /Mitarbeiter Max/ }).click();
    await expect(page.locator("h1").first()).toBeVisible();
    expect(await scan(page), `Mitarbeiterprofil (${scheme})`).toEqual([]);
  }
});

test("Dienstplan-Detailseite hat keine WCAG-A/AA-Verstöße", async ({ page }) => {
  await login(page, "admin");
  // eigenes Testdatum anlegen, damit der Test auch auf einer frischen Datenbank läuft
  const tag = Date.now().toString(36).toUpperCase();
  await page.goto("/roster/settings");
  await page.getByLabel("Name").first().fill(`A11y-Standort ${tag}`);
  await page.getByRole("button", { name: "Anlegen" }).first().click();
  await expect(page.getByText(`A11y-Standort ${tag}`)).toBeVisible();
  await page.goto("/roster");
  await page.getByLabel("Standort").selectOption({ label: `A11y-Standort ${tag}` });
  await page.getByLabel("Von").fill("2031-03-03");
  await page.getByLabel("Bis").fill("2031-03-09");
  await page.getByRole("button", { name: "Plan anlegen" }).click();
  await page.waitForURL(/\/roster\/[^/]+$/);
  await page.getByLabel("Datum").fill("2031-03-03");
  await page.getByRole("button", { name: "Schicht hinzufügen" }).click();
  await expect(page.getByText(/08:00–16:30/)).toBeVisible();
  const url = page.url();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(url);
    await expect(page.locator("h1").first()).toBeVisible();
    expect(await scan(page), `Dienstplan (${scheme})`).toEqual([]);
  }
});

test("Zeiten-Detailseite einer Person hat keine WCAG-A/AA-Verstöße", async ({ page }) => {
  await login(page, "admin");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/time/team");
    await page.getByRole("table").getByRole("link").first().click();
    await expect(page.locator("h1").first()).toContainText("Zeiten:");
    expect(await scan(page), `Zeiten Person (${scheme})`).toEqual([]);
  }
});

test("Tastaturbedienung: Tab erreicht die Navigation, Fokus ist sichtbar", async ({ page }) => {
  await login(page, "admin");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});
