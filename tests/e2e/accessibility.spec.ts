import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { login } from "./helpers";

// Automatische WCAG-2-A/AA-Prüfung (axe-core). Deckt nur einen Teil der Barrierefreiheit ab – ersetzt keinen manuellen Test.
const pages = ["/", "/departments", "/cost-centers", "/budgets", "/suppliers", "/procurement", "/audit", "/copilot", "/notifications", "/settings/approvals", "/planned/finance"];

async function scan(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
}

test("Login-Seite hat keine WCAG-A/AA-Verstöße", async ({ page }) => {
  await page.goto("/login");
  expect(await scan(page)).toEqual([]);
});

test("angemeldete Seiten haben keine WCAG-A/AA-Verstöße (hell und dunkel)", async ({ page }) => {
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

test("Tastaturbedienung: Tab erreicht die Navigation, Fokus ist sichtbar", async ({ page }) => {
  await login(page, "admin");
  await page.keyboard.press("Tab");
  const focused = page.locator(":focus");
  await expect(focused).toBeVisible();
  const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});
