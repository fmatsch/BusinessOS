import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// Dienstplanung über drei Rollen: Planung (Inhaber), Mitarbeiter, Führungskraft.
test.describe.serial("Dienstplanung Ende-zu-Ende (Browser)", () => {
  const tag = Date.now().toString(36).toUpperCase();
  const site = `E2E-Standort ${tag}`;
  // zufällige Woche im nächsten Jahr (Schichten sind dann zukünftig; Kollisionen mit früheren lokalen Läufen sind unwahrscheinlich)
  const year = new Date().getUTCFullYear() + 1;
  const d = new Date(Date.UTC(year, 0, 4 + 7 * Math.floor(Math.random() * 50)));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  const monday = d.toISOString().slice(0, 10);
  const sunday = new Date(d.getTime() + 6 * 86_400_000).toISOString().slice(0, 10);
  let rosterUrl = "";

  async function expectNotification(page: Page, text: RegExp) {
    await page.goto("/notifications");
    await expect
      .poll(async () => { await page.reload(); return page.getByText(text).count(); }, { timeout: 20_000, intervals: [500, 1000, 2000] })
      .toBeGreaterThan(0);
  }

  test("Planung legt Standort, Plan und Schichten an; Regelverstoß wird verhindert; Veröffentlichung", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/roster/settings");
    await page.getByRole("heading", { name: "Standorte" }).waitFor();
    await page.getByLabel("Name").first().fill(site);
    await page.getByRole("button", { name: "Anlegen" }).first().click();
    await expect(page.getByText(site)).toBeVisible();

    await page.goto("/roster");
    await page.getByLabel("Standort").selectOption({ label: site });
    await page.getByLabel("Von").fill(monday);
    await page.getByLabel("Bis").fill(sunday);
    await page.getByRole("button", { name: "Plan anlegen" }).click();
    await page.waitForURL(/\/roster\/[^/]+$/);
    rosterUrl = new URL(page.url()).pathname;
    await expect(page.getByRole("heading", { name: new RegExp(site) })).toBeVisible();
    await expect(page.getByText(/Entwurf – noch nicht veröffentlicht/)).toBeVisible();

    // Schicht 08:00–16:30 und eine überschneidende 12:00–20:30
    await page.getByLabel("Datum").fill(monday);
    await page.getByLabel("Bezeichnung").fill("E2E Früh");
    await page.getByRole("button", { name: "Schicht hinzufügen" }).click();
    await expect(page.getByText(/08:00–16:30/)).toBeVisible();
    await page.getByLabel("Datum").fill(monday);
    await page.getByLabel("Beginn").fill("12:00");
    await page.getByLabel("Ende").fill("20:30");
    await page.getByLabel("Bezeichnung").fill("E2E Spät");
    await page.getByRole("button", { name: "Schicht hinzufügen" }).click();
    await expect(page.getByText(/12:00–20:30/)).toBeVisible();

    const early = page.getByRole("listitem").filter({ hasText: "E2E Früh" }).first();
    await early.getByRole("combobox").selectOption({ label: "Mitarbeiter Max" });
    await early.getByRole("button", { name: "Zuweisen" }).click();
    await expect(early.getByText("Max Mitarbeiter")).toBeVisible();

    // Doppelbuchung wird verhindert
    const late = page.getByRole("listitem").filter({ hasText: "E2E Spät" }).first();
    await late.getByRole("combobox").selectOption({ label: "Mitarbeiter Max" });
    await late.getByRole("button", { name: "Zuweisen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Überschneidende Schichten/ })).toBeVisible();

    // Unterbesetzung ist nur ein Hinweis, die Veröffentlichung bleibt möglich
    await expect(page.getByText(/0 Regelverstöße/)).toBeVisible();
    await page.getByRole("button", { name: "Veröffentlichen" }).click();
    await expect(page.getByText(/Veröffentlicht: Version 1/)).toBeVisible();
    await logout(page);
  });

  test("Mitarbeiter sieht Dienst, bekommt Benachrichtigung und kann den Kalender laden", async ({ page }) => {
    await login(page, "employee");
    await expectNotification(page, new RegExp(`Dienstplan ${site}`));
    await page.goto("/roster");
    const row = page.getByRole("row").filter({ hasText: site });
    await expect(row).toBeVisible();
    await expect(row).toContainText("E2E Früh");
    // Kalender-Export: gültige iCalendar-Datei mit den eigenen Schichten
    const res = await page.context().request.get("/roster/my.ics");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/calendar");
    const ics = await res.text();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain(site);
    await logout(page);
  });

  test("Tausch: Anfrage, Kollegin übernimmt, Freigabe durch Planung", async ({ page }) => {
    await login(page, "employee");
    await page.goto("/roster");
    const row = page.getByRole("row").filter({ hasText: site });
    await row.getByRole("combobox", { name: /Tauschen mit/ }).selectOption({ label: "Führung Franka" });
    await row.getByRole("button", { name: "Anfragen" }).click();
    await expect(row.getByText("Anfrage offen")).toBeVisible();
    await logout(page);

    await login(page, "manager");
    await expectNotification(page, /Tauschanfrage von Max Mitarbeiter/);
    await page.goto("/roster");
    const req = page.getByRole("listitem").filter({ hasText: site }).filter({ hasText: "möchte Schicht abgeben" }).first();
    await req.getByRole("button", { name: "Übernehmen" }).click();
    await expect(page.getByText(/wartet auf Freigabe/)).toBeVisible();
    await logout(page);

    await login(page, "admin");
    await expectNotification(page, /Schichttausch wartet auf Freigabe/);
    await page.goto("/roster");
    const approve = page.getByRole("listitem").filter({ hasText: site }).filter({ hasText: "↔" }).first();
    await approve.getByRole("button", { name: "Freigeben" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: site }).filter({ hasText: "↔" })).toHaveCount(0);
    await page.goto(rosterUrl);
    await expect(page.getByText(/Veröffentlicht: Version 2/)).toBeVisible();
    await logout(page);

    await login(page, "manager");
    await page.goto("/roster");
    const mySection = page.locator("section").filter({ has: page.getByRole("heading", { name: "Mein Dienstplan" }) });
    await expect(mySection.getByRole("row").filter({ hasText: site })).toBeVisible(); // jetzt Franka
    await logout(page);

    await login(page, "employee");
    await page.goto("/roster");
    await expect(page.getByRole("row").filter({ hasText: site })).toHaveCount(0); // nicht mehr Max
  });

  test("Berechtigungen: Mitarbeiter kann weder planen noch Einstellungen sehen", async ({ page }) => {
    await page.context().clearCookies();
    await login(page, "employee");
    await page.goto("/roster/settings");
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    await page.goto(rosterUrl);
    await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Veröffentlichen" })).toHaveCount(0);
  });
});
