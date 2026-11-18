import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// CRM: Kundenakte (Kontakt, Aktivität) → Angebot → Freigabe durch die Führungskraft → Versand mit Nummer und PDF → Annahme → Rechnungsentwurf.
test.describe.serial("CRM und Angebote (Browser)", () => {
  const tag = Date.now().toString(36).toUpperCase();
  const customerNo = `CR${tag}`, customerName = `CRM Kunde ${tag}`, taxOut = `C${tag}`, title = `Wartung ${tag}`;
  const today = new Date().toISOString().slice(0, 10);
  const nextYear = `${new Date().getUTCFullYear() + 1}-06-30`;
  let quoteUrl = "";

  const form = (page: Page, button: string) => page.locator("form").filter({ has: page.getByRole("button", { name: button, exact: true }) });

  test("Vorbereitung: Steuerkennzeichen und Kunde", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/finance/settings");
    const f = form(page, "Steuerkennzeichen anlegen");
    await f.getByLabel("Schlüssel", { exact: true }).fill(taxOut);
    await f.getByLabel("Bezeichnung").fill("Umsatzsteuer 20 %");
    await f.getByLabel("Satz (%)").fill("20");
    await f.getByLabel("Art").selectOption("OUTPUT");
    await f.getByRole("button", { name: "Steuerkennzeichen anlegen" }).click();
    await expect(page.getByRole("cell", { name: taxOut, exact: true })).toBeVisible();
    const cf = form(page, "Kunde anlegen");
    await cf.getByLabel("Nummer").fill(customerNo);
    await cf.getByLabel("Name").fill(customerName);
    await cf.getByRole("button", { name: "Kunde anlegen" }).click();
    await expect(page.getByText(customerName).first()).toBeVisible();
    await logout(page);
  });

  test("Kundenakte: Kontakt und Aktivität anlegen, Kontaktdaten löschen", async ({ page }) => {
    await login(page, "finance");
    await page.goto("/crm");
    await page.getByRole("link", { name: new RegExp(customerName) }).click();
    await expect(page.getByRole("heading", { name: new RegExp(customerName) })).toBeVisible();
    const cf = form(page, "Kontakt anlegen");
    await cf.getByLabel("Name").fill("Erika Muster");
    await cf.getByLabel("E-Mail").fill("erika@kunde.example");
    await cf.getByRole("button", { name: "Kontakt anlegen" }).click();
    await expect(page.getByText(/Erika Muster.*erika@kunde.example/)).toBeVisible();
    const af = form(page, "Eintragen");
    await af.getByLabel("Betreff").fill("Bedarf besprochen");
    await af.getByRole("button", { name: "Eintragen" }).click();
    await expect(page.getByText("Bedarf besprochen")).toBeVisible();
    await page.getByRole("button", { name: /Personenbezogene Daten von Erika Muster löschen/ }).click();
    await expect(page.getByText("erika@kunde.example")).toHaveCount(0);
    await expect(page.getByText("Gelöschter Kontakt")).toBeVisible();
    await logout(page);
  });

  test("Angebot anlegen und einreichen", async ({ page }) => {
    await login(page, "finance");
    await page.goto("/crm/quotes");
    const f = form(page, "Entwurf anlegen");
    await f.locator('select[name="customerId"]').selectOption({ label: `${customerNo} ${customerName}` });
    await f.getByLabel("Titel").fill(title);
    await f.getByLabel("Gültig bis").fill(nextYear);
    await f.getByLabel("Beschreibung 1").fill("Wartung");
    await f.getByLabel("Menge 1").fill("2");
    await f.getByLabel("Einzelpreis 1").fill("100");
    await f.getByLabel("Steuerkennzeichen 1").selectOption({ label: `${taxOut} (20 %)` });
    await f.getByRole("button", { name: "Entwurf anlegen" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(title) })).toBeVisible();
    quoteUrl = new URL(page.url()).pathname;
    await expect(page.getByText("Status: Entwurf")).toBeVisible();
    await page.getByRole("button", { name: "Zur Freigabe einreichen" }).click();
    await expect(page.getByText("Status: wartet auf Freigabe")).toBeVisible();
    await expect(page.getByRole("button", { name: /Versenden/ })).toHaveCount(0); // nie ohne Freigabe
    await logout(page);
  });

  test("Führungskraft gibt frei", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/crm/quotes");
    const item = page.getByRole("listitem").filter({ hasText: title });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Freigeben" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
    await logout(page);
  });

  test("Versenden mit Nummer und PDF, Annahme erzeugt Rechnungsentwurf", async ({ page }) => {
    await login(page, "finance");
    await page.goto(quoteUrl);
    await expect(page.getByText("Status: freigegeben")).toBeVisible();
    await page.getByRole("button", { name: /Versenden/ }).click();
    await expect(page.getByRole("heading", { name: /^AN-\d{4}-\d{4}/ })).toBeVisible();
    const link = page.getByRole("link", { name: "PDF öffnen" });
    const res = await page.request.get(await link.getAttribute("href") as string);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/pdf");
    expect((await res.body()).toString("latin1")).toMatch(/\(AN-\d{4}-\d{4}\)/);
    await page.getByRole("button", { name: /Kunde hat angenommen/ }).click();
    await expect(page).toHaveURL(/\/finance\/out\//);
    await expect(page.getByRole("heading", { name: new RegExp(`Entwurf · ${customerName}`) })).toBeVisible();
    await expect(page.getByText("240,00").first()).toBeVisible(); // 200 netto + 20 % USt
    await logout(page);
  });

  test("Mitarbeiter haben keinen Zugriff", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/crm");
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    const res = await page.request.get(`${quoteUrl}/pdf`);
    expect(res.status()).toBe(403);
    expect(today).toBeTruthy();
    await logout(page);
  });
});
