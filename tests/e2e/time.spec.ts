import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// Zeiterfassung über drei Rollen: Mitarbeiter, Führungskraft, Personalwesen (Inhaber).
test.describe.serial("Zeiterfassung Ende-zu-Ende (Browser)", () => {
  // zufälliger Monat der letzten 20 Monate (frühere lokale Läufe haben ihren Monat bereits abgeschlossen)
  const now = new Date();
  const back = 1 + Math.floor(Math.random() * 20);
  const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const year = ref.getUTCFullYear(), month = ref.getUTCMonth() + 1;
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const reason = `E2E-Nachtrag ${Date.now().toString(36)}`;
  let employeeUrl = "";

  async function expectNotification(page: Page, text: RegExp) {
    await page.goto("/notifications");
    await expect
      .poll(async () => { await page.reload(); return page.getByText(text).count(); }, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(0);
  }

  test("Mitarbeiter: Stempeluhr bedienen und Zeit nachtragen", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/time");
    await expect(page.getByText("Nicht eingestempelt")).toBeVisible();
    await page.getByRole("button", { name: "Einstempeln" }).click();
    await expect(page.getByText(/Eingestempelt seit/)).toBeVisible();
    await page.getByRole("button", { name: "Pause beginnen" }).click();
    await expect(page.getByText(/in Pause/)).toBeVisible();
    await page.getByRole("button", { name: "Pause beenden" }).click();
    await page.getByRole("button", { name: "Verwerfen" }).click();
    await expect(page.getByText("Nicht eingestempelt")).toBeVisible();

    // Nachtrag in einem Monat der Vergangenheit; bei Überschneidung mit früheren Läufen anderen Tag versuchen
    let done = false;
    for (let attempt = 0; attempt < 8 && !done; attempt++) {
      const day = String(1 + Math.floor(Math.random() * 27)).padStart(2, "0");
      await page.goto(`/time?month=${ym}`);
      await page.getByRole("heading", { name: "Zeit nachtragen" }).waitFor();
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Antrag stellen" }) });
      await form.getByLabel("Datum").fill(`${ym}-${day}`);
      await form.getByLabel("Beginn").fill("08:00");
      await form.getByLabel("Ende").fill("16:30");
      await form.getByLabel("Pause (min)").fill("30");
      await form.getByLabel("Begründung").fill(reason);
      await form.getByRole("button", { name: "Antrag stellen" }).click();
      await page.waitForLoadState("networkidle");
      done = (await page.getByRole("alert").filter({ hasText: /überschneidet|gesperrt|eingereicht/ }).count()) === 0 && (await page.getByText(reason).count()) > 0;
    }
    expect(done).toBe(true);
    await expect(page.getByRole("listitem").filter({ hasText: reason })).toContainText("offen");
    await logout(page);
  });

  test("Führungskraft wird benachrichtigt und genehmigt den Nachtrag", async ({ page }) => {
    await login(page, "manager");
    await expectNotification(page, /Zeitantrag: Max Mitarbeiter/);
    await page.goto(`/time/team?month=${ym}`);
    const item = page.getByRole("listitem").filter({ hasText: reason });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Genehmigen" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: reason })).toHaveCount(0);
    await logout(page);
  });

  test("Mitarbeiter reicht den Monat ein", async ({ page }) => {
    await login(page, "employee");
    await expectNotification(page, /Zeitantrag genehmigt/);
    await page.goto(`/time?month=${ym}`);
    await expect(page.getByRole("cell", { name: /Nachtrag · Antrag .*E2E-Nachtrag/ }).first()).toBeVisible();
    await expect(page.getByText(/Status des Monats: offen/)).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`Monat ${ym} einreichen`) }).click();
    await expect(page.getByText(/Status des Monats: eingereicht/)).toBeVisible();
    // eingereichte Monate sind für die Person gesperrt
    await expect(page.getByRole("button", { name: "Antrag stellen" })).toHaveCount(0);
    await logout(page);
  });

  test("Führungskraft prüft und gibt den Monat frei; Monat ist gesperrt", async ({ page }) => {
    await login(page, "manager");
    await expectNotification(page, /Monatsabschluss eingereicht: Max Mitarbeiter/);
    await page.goto(`/time/team?month=${ym}`);
    const row = page.getByRole("row").filter({ hasText: "Mitarbeiter Max" });
    await expect(row).toContainText("wartet auf Freigabe");
    await row.getByRole("link").click();
    await page.waitForURL(/\/time\/employee\/[^/]+/);
    employeeUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { name: "Zeiten: Max Mitarbeiter" })).toBeVisible();
    await page.getByRole("button", { name: "Freigeben und sperren" }).click();
    await expect(page.getByText(/freigegeben \(gesperrt\)/)).toBeVisible();
    await logout(page);

    await login(page, "employee");
    await expectNotification(page, /Monatsabschluss .* freigegeben/);
    await page.goto(`/time?month=${ym}`);
    await expect(page.getByText(/freigegeben und gesperrt/)).toBeVisible();
    await expect(page.getByText("Ändern …")).toHaveCount(0);
    await logout(page);
  });

  test("Datenschutz: Führungskraft sieht nur ihr Team, Mitarbeiter keine Fremddaten", async ({ page }) => {
    // Adresse einer fremden Person (Finanzen) über die Übersicht des Personalwesens ermitteln
    await login(page, "admin");
    await page.goto(`/time/team?month=${ym}`);
    const link = page.getByRole("link", { name: /Finanzen Finn/ });
    const other = new URL((await link.getAttribute("href"))!, page.url()).pathname;
    await logout(page);

    await login(page, "manager");
    await page.goto(other);
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible(); // nicht im Team von Franka
    await logout(page);

    await login(page, "employee");
    await page.goto("/time/team");
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    await page.goto(other);
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    await page.goto(employeeUrl); // eigene Daten bleiben erreichbar? (eigene Detailansicht über /time)
    await expect(page.getByRole("heading", { name: "Zeiten: Max Mitarbeiter" })).toBeVisible();
    await logout(page);
  });

  test("Personalwesen öffnet den Monat wieder (mit Begründung); Audit-Log enthält Abschluss und Fremdzugriffe", async ({ page }) => {
    await login(page, "admin");
    await page.goto(`${employeeUrl}?month=${ym}`);
    await expect(page.getByText(/freigegeben \(gesperrt\)/)).toBeVisible();
    await page.getByLabel("Begründung für das Wiederöffnen").fill("E2E-Aufräumen");
    await page.getByRole("button", { name: "Monat wieder öffnen" }).click();
    await expect(page.getByText(/Status des Monats: offen/)).toBeVisible();
    await page.goto("/audit");
    for (const action of ["time.period_approve", "time.period_reopen", "time.read_other", "time.request_approve"])
      await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
    await logout(page);
  });
});
