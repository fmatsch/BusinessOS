import { expect, type Page } from "@playwright/test";

export const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "";
export const USERS = {
  admin: "admin@demo.example",
  employee: "mitarbeiter@demo.example",
  manager: "fuehrung@demo.example",
  finance: "finanzen@demo.example",
} as const;

export async function login(page: Page, who: keyof typeof USERS) {
  expect(PASSWORD, "SEED_DEMO_PASSWORD muss gesetzt sein").not.toBe("");
  await page.goto("/login");
  await page.getByLabel("E-Mail").fill(USERS[who]);
  await page.getByLabel(/Passwort/).fill(PASSWORD);
  await page.getByRole("button", { name: "Anmelden" }).click();
  await expect(page).toHaveURL(/\/$/);
}

export async function logout(page: Page) {
  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect(page).toHaveURL(/\/login/);
}
