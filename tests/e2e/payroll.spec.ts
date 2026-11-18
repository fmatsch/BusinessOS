import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// Lohn-Export: Profil → freigegebener Monat → Vorschau/Prüfung → Exportlauf → Download.
test.describe.serial("Lohn-Export Ende-zu-Ende (Browser)", () => {
  const now = new Date();
  const back = 1 + Math.floor(Math.random() * 20);
  const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const ym = `${ref.getUTCFullYear()}-${String(ref.getUTCMonth() + 1).padStart(2, "0")}`;
  let employeeUrl = "";

  async function expectNotification(page: Page, text: RegExp) {
    await page.goto("/notifications");
    await expect
      .poll(async () => { await page.reload(); return page.getByText(text).count(); }, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(0);
  }

  test("Personalwesen hinterlegt Format und Lohnarten", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/payroll");
    await expect(page.getByRole("heading", { name: "Lohn-Export" })).toBeVisible();
    const codes: Record<string, string> = {
      "Normalarbeitszeit": "1000", "Mehrzeit über Soll": "2000", "Nachtarbeit (Zuschlagsbasis)": "3000", "Sonntagsarbeit (Zuschlagsbasis)": "3100",
      "Feiertagsarbeit (Zuschlagsbasis)": "3200", "Urlaub": "9000", "Krankenstand": "9100", "Pflegefreistellung": "9200", "Sonderurlaub": "9300",
    };
    for (const [label, code] of Object.entries(codes)) await page.getByLabel(`Lohnart für ${label}`, { exact: true }).fill(code);
    await page.getByRole("button", { name: "Profil speichern" }).click();
    await expect(page.getByLabel("Lohnart für Normalarbeitszeit", { exact: true })).toHaveValue("1000");
    await logout(page);
  });

  test("Zeiten für einen Monat erfassen, einreichen und freigeben", async ({ page }) => {
    await login(page, "admin");
    await page.goto(`/time/team?month=${ym}`);
    const link = page.getByRole("row").filter({ hasText: "Mitarbeiter Max" }).getByRole("link");
    employeeUrl = new URL((await link.getAttribute("href"))!, page.url()).pathname;

    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const day = String(1 + Math.floor(Math.random() * 27)).padStart(2, "0");
      await page.goto(`${employeeUrl}?month=${ym}`);
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Erfassen" }) });
      await form.getByLabel("Datum").fill(`${ym}-${day}`);
      await form.getByLabel("Beginn").fill("22:00"); // Nachtarbeit
      await form.getByLabel("Ende").fill("06:00");
      await form.getByLabel("Pause (min)").fill("30");
      await form.getByLabel("Begründung").fill("E2E Lohn-Export");
      await form.getByRole("button", { name: "Erfassen" }).click();
      await page.waitForLoadState("networkidle");
      done = (await page.getByRole("alert").filter({ hasText: /überschneidet|gesperrt/ }).count()) === 0;
    }
    expect(done).toBe(true);
    await logout(page);

    await login(page, "employee");
    await page.goto(`/time?month=${ym}`);
    const submit = page.getByRole("button", { name: new RegExp(`Monat ${ym} einreichen`) });
    if (await submit.count()) await submit.click();
    await expect(page.getByText(/Status des Monats: eingereicht/)).toBeVisible();
    await logout(page);

    await login(page, "manager");
    await expectNotification(page, /Monatsabschluss eingereicht: Max Mitarbeiter/);
    await page.goto(`${employeeUrl}?month=${ym}`);
    await page.getByRole("button", { name: "Freigeben und sperren" }).click();
    await expect(page.getByText(/freigegeben \(gesperrt\)/)).toBeVisible();
    await logout(page);
  });

  test("Vorschau und Prüfung, Exportlauf, Download; ohne Änderungen kein weiterer Lauf", async ({ page }) => {
    await login(page, "admin");
    await page.goto(`/payroll?month=${ym}`);
    await expect(page.getByRole("heading", { name: `Prüfung ${ym}` })).toBeVisible();
    const preview = page.getByRole("row").filter({ hasText: "Mitarbeiter Max" });
    await expect(preview.first()).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Nachtarbeit" })).toBeVisible(); // Zuschlagsbasis aus der Nachtschicht
    await expect(page.getByText(/noch nicht vollständig/)).toBeVisible(); // andere Beschäftigte ohne freigegebenen Monat

    // ohne Bestätigung der Unvollständigen ist der Export nicht möglich
    await page.getByRole("button", { name: "Export erzeugen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /keinen freigegebenen Monat/ })).toBeVisible();

    await page.goto(`/payroll?month=${ym}`);
    await page.getByLabel(/Unvollständige Beschäftigte jetzt auslassen/).check();
    await page.getByRole("button", { name: "Export erzeugen" }).click();
    const run = page.getByRole("row").filter({ hasText: ym }).filter({ hasText: "Herunterladen" }).first();
    await expect(run).toBeVisible();

    // Download: Datei enthält Personalnummer, Lohnart und Zeitraum; Prüfsumme wird serverseitig geprüft
    const href = await run.getByRole("link", { name: "Herunterladen" }).getAttribute("href");
    const res = await page.context().request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toContain("lohnexport-");
    const csv = (await res.body()).toString("utf8");
    expect(csv).toContain("Personalnummer;Zeitraum;Lohnart");
    expect(csv).toMatch(new RegExp(`101;${ym};1000;Normalarbeitszeit`));
    expect(csv).toMatch(new RegExp(`101;${ym};3000;Nachtarbeit`));

    // Direkt danach: keine Änderungen, Export gesperrt
    await page.goto(`/payroll?month=${ym}`);
    await expect(page.getByText(/Keine Änderungen seit dem letzten Export|Nichts zu exportieren/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Export erzeugen" })).toBeDisabled();
    await logout(page);
  });

  test("Zugriff: Mitarbeiter und Führungskraft sehen den Lohn-Export nicht; Finanzen darf lesen, aber nicht exportieren", async ({ page }) => {
    for (const who of ["employee", "manager"] as const) {
      await login(page, who);
      await page.goto("/payroll");
      await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
      const res = await page.context().request.get("/payroll/download/irgendeine-id");
      expect(res.status()).toBe(403);
      await logout(page);
    }
    await login(page, "finance");
    await page.goto(`/payroll?month=${ym}`);
    await expect(page.getByRole("heading", { name: "Lohn-Export" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Export erzeugen" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Profil speichern" })).toHaveCount(0);
    await logout(page);
  });

  test("Audit-Log enthält Export und Abruf", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/audit");
    for (const action of ["payroll.export", "payroll.download", "payroll_profile.set"])
      await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
    // Aufräumen des Monats (offen halten), damit spätere Läufe unabhängig bleiben
    await page.goto(`${employeeUrl}?month=${ym}`);
    await page.getByLabel("Begründung für das Wiederöffnen").fill("E2E-Aufräumen");
    await page.getByRole("button", { name: "Monat wieder öffnen" }).click();
    await expect(page.getByText(/Status des Monats: offen/)).toBeVisible();
    await logout(page);
  });
});
