import { expect, test } from "@playwright/test";
import { login, logout } from "./helpers";

// Ein durchgehendes Szenario über vier Rollen: Anforderung → Freigabe → Bestellung → Budget → Dashboard.
test.describe.serial("Beschaffungsprozess Ende-zu-Ende (Browser)", () => {
  const s = Date.now().toString(36).toUpperCase();
  const cc = `E${s}`;
  const supplier = `S${s}`;
  const title = `Laptops ${s}`;

  test("Inhaber legt Kostenstelle, Lieferant und Budget an", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/cost-centers");
    await page.getByLabel("Code").fill(cc);
    await page.getByLabel("Name").fill(`Test ${s}`);
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("cell", { name: cc, exact: true })).toBeVisible();

    await page.goto("/suppliers");
    await page.getByLabel("Nummer").fill(supplier);
    await page.getByLabel("Name").fill(`Lieferant ${s}`);
    await page.getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("cell", { name: supplier, exact: true })).toBeVisible();

    await page.goto("/budgets");
    await page.getByLabel("Kostenstelle").selectOption({ label: `${cc} · Test ${s}` });
    await page.getByLabel(/Budget \(/).fill("1000");
    await page.getByRole("button", { name: "Speichern" }).click();
    await expect(page.getByRole("row", { name: new RegExp(cc) })).toContainText("1.000,00");
    await logout(page);
  });

  test("Mitarbeiter reicht eine Anforderung ein (1.200 €)", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/procurement");
    await page.getByLabel("Titel").fill(title);
    await page.getByLabel("Kostenstelle (optional)").selectOption({ label: `${cc} · Test ${s}` });
    await page.getByLabel("Beschreibung 1").fill("Notebook");
    await page.getByLabel("Menge 1").fill("2");
    await page.getByLabel("Stückpreis 1").fill("600");
    await page.getByRole("button", { name: "Einreichen" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(title) })).toBeVisible();
    await expect(page.getByText("Status: Eingereicht")).toBeVisible();
    // Mitarbeiter sieht keine Freigabe- oder Bestell-Formulare
    await expect(page.getByRole("button", { name: /Freigeben/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Bestellen" })).toHaveCount(0);
    await logout(page);
  });

  test("Führungskraft gibt frei", async ({ page }) => {
    await login(page, "manager");
    await page.goto("/procurement");
    await page.getByRole("row", { name: new RegExp(title) }).getByRole("link").click();
    await page.getByRole("button", { name: /Freigeben/ }).click();
    await expect(page.getByText("Status: Freigegeben")).toBeVisible();
    await logout(page);
  });

  test("Finanzen legt die Bestellung an; Budget ist überschritten", async ({ page }) => {
    await login(page, "finance");
    await page.goto("/procurement");
    await page.getByRole("row", { name: new RegExp(title) }).getByRole("link").click();
    await page.getByLabel("Lieferant").selectOption({ label: `${supplier} · Lieferant ${s}` });
    await page.getByRole("button", { name: "Bestellen" }).click();
    await expect(page.getByText("Status: Bestellt")).toBeVisible();
    await expect(page.getByText(/Budget der Kostenstelle ist damit überschritten/)).toBeVisible();

    await page.goto("/budgets");
    const row = page.getByRole("row", { name: new RegExp(cc) });
    await expect(row).toContainText("1.200,00");
    await expect(row).toContainText("überschritten");
    await logout(page);
  });

  test("Dashboard und Audit-Log des Inhabers zeigen das Ergebnis", async ({ page }) => {
    await login(page, "admin");
    await expect(page.getByText("Kostenstellen über Budget")).toBeVisible();
    await page.goto("/audit");
    for (const action of ["purchase_order.create", "purchase_request.approve_step", "purchase_request.submit", "budget.set"])
      await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
    await logout(page);
  });

  test("Mandantentrennung: die zweite Organisation sieht die Kostenstelle nicht", async ({ page }) => {
    await login(page, "admin");
    await page.getByLabel("Organisation").selectOption({ label: "Beispiel AG" });
    await page.getByRole("button", { name: "OK" }).click();
    // Erst weitermachen, wenn der Wechsel serverseitig wirksam ist (Server Action ist asynchron)
    await expect(page.getByRole("heading", { name: "Beispiel AG", level: 1 })).toBeVisible();
    await page.goto("/cost-centers");
    await expect(page.getByRole("heading", { name: "Kostenstellen" })).toBeVisible();
    await expect(page.getByRole("cell", { name: cc, exact: true })).toHaveCount(0);
    await page.goto("/procurement");
    await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);
  });

  test("Mitarbeiter ohne Berechtigung sieht Audit-Log und Budgets nicht", async ({ page }) => {
    await login(page, "employee");
    for (const path of ["/audit", "/budgets"]) {
      await page.goto(path);
      await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    }
  });

  test("ohne Anmeldung leitet jede geschützte Seite zum Login", async ({ page }) => {
    for (const path of ["/", "/procurement", "/budgets", "/audit", "/copilot"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("falsche Anmeldedaten werden abgewiesen", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("E-Mail").fill("admin@demo.example");
    await page.getByLabel(/Passwort/).fill("falsches-passwort-123");
    await page.getByRole("button", { name: "Anmelden" }).click();
    await expect(page.getByText("Anmeldung fehlgeschlagen.")).toBeVisible();
  });

  test("Sicherheits-Header sind gesetzt", async ({ request }) => {
    const res = await request.get("/login");
    const h = res.headers();
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-powered-by"]).toBeUndefined();
  });
});
