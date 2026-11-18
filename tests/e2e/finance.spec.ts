import { expect, test, type Page } from "@playwright/test";
import { login, logout } from "./helpers";

// Finanzen: Stammdaten → Eingangsrechnung (Vier-Augen) → Ausgangsrechnung → Export für BMD und DATEV mit Download.
test.describe.serial("Finanzen und Export an die Steuerberatung (Browser)", () => {
  const tag = Date.now().toString(36).toUpperCase();
  const supplierNo = `LF${tag}`;
  const supplierName = `E2E Lieferant ${tag}`;
  const customerNo = `KD${tag}`;
  const customerName = `E2E Kunde ${tag}`;
  const rnd5 = () => String(30000 + Math.floor(Math.random() * 60000)); // Personenkonten haben 5 Stellen (4 Stellen Sachkonten)
  const vendorAcc = rnd5(), debtorAcc = String(Number(rnd5()) % 90000 + 10000 === Number(vendorAcc) ? 10001 : Number(rnd5()));
  const taxIn = `V${tag}`, taxOut = `U${tag}`;
  const today = new Date().toISOString().slice(0, 10);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

  function form(page: Page, button: string) {
    return page.locator("form").filter({ has: page.getByRole("button", { name: button, exact: true }) });
  }
  async function setProfile(page: Page, format: "BMD" | "DATEV") {
    await page.goto("/finance/settings");
    const f = form(page, "Profil speichern");
    await f.locator('select[name="format"]').selectOption(format);
    await f.getByLabel("DATEV: Beraternummer").fill("12345");
    await f.getByLabel("DATEV: Mandantennummer").fill("67890");
    await f.getByLabel("Stellen der Sachkonten").fill("4");
    await f.getByRole("button", { name: "Profil speichern" }).click();
    await page.waitForLoadState("networkidle");
    await page.reload(); // erst nach dem Neuladen steht der gespeicherte Wert fest
    await expect(page.locator('select[name="format"]')).toHaveValue(format);
  }
  async function newSupplierInvoice(page: Page, number: string, net: string) {
    await page.goto("/finance/in");
    const f = form(page, "Rechnung erfassen");
    await f.locator('select[name="supplierId"]').selectOption({ label: `${supplierNo} ${supplierName}` });
    await f.getByLabel("Rechnungsnummer").fill(number);
    await f.getByLabel("Rechnungsdatum").fill(today);
    await f.locator('input[type="file"]').setInputFiles({ name: "rechnung.pdf", mimeType: "application/pdf", buffer: pdf });
    await f.getByLabel("Beschreibung 1").fill("Material");
    await f.getByLabel("Netto 1").fill(net);
    await f.getByLabel("Steuerkennzeichen 1").selectOption({ label: `${taxIn} (20 %)` });
    await f.getByRole("button", { name: "Rechnung erfassen" }).click();
    await page.waitForURL(/\/finance\/in\/[^/]+$/);
    await expect(page.getByText(/wartet auf Freigabe/).first()).toBeVisible();
    return new URL(page.url()).pathname;
  }
  async function approveAsFinance(page: Page, url: string) {
    await login(page, "finance");
    await page.goto(url);
    await page.getByRole("button", { name: "Freigeben" }).click();
    await expect(page.getByText(/Status: freigegeben/)).toBeVisible();
    await expect(page.getByRole("heading", { name: /^ER-\d{4}-\d{4}/ })).toBeVisible();
    await logout(page);
  }
  async function runExport(page: Page) {
    await page.goto("/finance/export");
    const accept = page.getByLabel("Hinweise zur Kenntnis genommen");
    if (await accept.count()) await accept.check();
    const rows = page.getByRole("row").filter({ hasText: "Buchungsdatei" });
    const before = await rows.count();
    await page.getByRole("button", { name: "Export erzeugen" }).click();
    await expect(rows).toHaveCount(before + 1); // erst wenn der neue Lauf da ist (der neueste steht oben)
    return rows.first();
  }

  test("Stammdaten: Konten, Steuerkennzeichen, Lieferant, Kunde, Zuordnung", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/finance/settings");
    await form(page, "Importieren").getByLabel("Kontenliste einfügen").fill("4000;Erlöse 20 %\n7000;Aufwand Material\n7100;Aufwand Dienstleistung");
    await form(page, "Importieren").getByRole("button", { name: "Importieren" }).click();
    for (const [num, name, type] of [[vendorAcc, `Kreditor E2E ${tag}`, "VENDOR"], [debtorAcc, `Debitor E2E ${tag}`, "CUSTOMER"]] as const) {
      const f = form(page, "Konto anlegen");
      await f.getByLabel("Nummer").fill(num);
      await f.getByLabel("Art").selectOption(type);
      await f.getByLabel("Bezeichnung").fill(name);
      await f.getByRole("button", { name: "Konto anlegen" }).click();
      await expect(page.getByRole("cell", { name: num, exact: true })).toBeVisible();
    }
    for (const [key, name, rate, dir, bmd, datev] of [[taxIn, "Vorsteuer 20 %", "20", "INPUT", "2", "9"], [taxOut, "Umsatzsteuer 20 %", "20", "OUTPUT", "1", "3"]] as const) {
      const f = form(page, "Steuerkennzeichen anlegen");
      await f.getByLabel("Schlüssel", { exact: true }).fill(key);
      await f.getByLabel("Bezeichnung").fill(name);
      await f.getByLabel("Satz (%)").fill(rate);
      await f.getByLabel("Art").selectOption(dir);
      await f.getByLabel("BMD-Steuercode").fill(bmd);
      await f.getByLabel("DATEV-BU-Schlüssel").fill(datev);
      await f.getByRole("button", { name: "Steuerkennzeichen anlegen" }).click();
      await expect(page.getByRole("cell", { name: key, exact: true })).toBeVisible();
    }
    // Lieferant (Beschaffung) und Kunde anlegen
    await page.goto("/suppliers");
    await form(page, "Anlegen").getByLabel("Nummer").fill(supplierNo);
    await form(page, "Anlegen").getByLabel("Name").fill(supplierName);
    await form(page, "Anlegen").getByRole("button", { name: "Anlegen" }).click();
    await expect(page.getByRole("cell", { name: supplierNo, exact: true })).toBeVisible();
    await page.goto("/finance/settings");
    const cf = form(page, "Kunde anlegen");
    await cf.getByLabel("Nummer").fill(customerNo);
    await cf.getByLabel("Name").fill(customerName);
    await cf.getByRole("button", { name: "Kunde anlegen" }).click();
    await expect(page.getByText(customerName).first()).toBeVisible();

    const sup = page.getByRole("listitem").filter({ hasText: supplierName });
    await sup.getByLabel("Kreditor").selectOption({ label: `${vendorAcc} Kreditor E2E ${tag}` });
    await sup.getByLabel("Standard-Aufwandskonto").selectOption({ label: "7000 Aufwand Material" });
    await sup.getByRole("button", { name: "Speichern" }).click();
    const cust = page.getByRole("listitem").filter({ hasText: customerName });
    await cust.getByLabel("Debitor").selectOption({ label: `${debtorAcc} Debitor E2E ${tag}` });
    await cust.getByLabel("Standard-Erlöskonto").selectOption({ label: "4000 Erlöse 20 %" });
    await cust.getByRole("button", { name: "Speichern" }).click();
    await page.reload();
    await expect(page.getByRole("listitem").filter({ hasText: supplierName }).getByLabel("Kreditor")).toHaveValue(/.+/);
    await logout(page);
  });

  test("Eingangsrechnung mit Beleg: erfassen, Vier-Augen-Freigabe durch Finanzen", async ({ page }) => {
    await login(page, "admin");
    const url = await newSupplierInvoice(page, `RE-${tag}-1`, "100");
    await expect(page.getByText("120,00").first()).toBeVisible(); // Brutto 120 inkl. 20 % Steuer
    await expect(page.getByRole("link", { name: "Belegdatei ansehen" })).toBeVisible();
    // Ersteller kann nicht selbst freigeben
    await page.getByRole("button", { name: "Freigeben" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Vier-Augen/ })).toBeVisible();
    const file = await page.context().request.get(await page.getByRole("link", { name: "Belegdatei ansehen" }).getAttribute("href") as string);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toBe("application/pdf");
    expect(file.headers()["x-content-type-options"]).toBe("nosniff");
    await logout(page);
    await approveAsFinance(page, url);
  });

  test("Upload einer Datei mit falschem Inhalt wird abgewiesen", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/finance/in");
    const f = form(page, "Rechnung erfassen");
    await f.locator('select[name="supplierId"]').selectOption({ label: `${supplierNo} ${supplierName}` });
    await f.getByLabel("Rechnungsnummer").fill(`BAD-${tag}`);
    await f.getByLabel("Rechnungsdatum").fill(today);
    await f.locator('input[type="file"]').setInputFiles({ name: "evil.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html><script>alert(1)</script>") });
    await f.getByLabel("Beschreibung 1").fill("x");
    await f.getByLabel("Netto 1").fill("1");
    await f.getByLabel("Steuerkennzeichen 1").selectOption({ label: `${taxIn} (20 %)` });
    await f.getByRole("button", { name: "Rechnung erfassen" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Nur PDF-, PNG- und JPEG/ })).toBeVisible();
    await logout(page);
  });

  test("Ausgangsrechnung: Entwurf, Ausstellen mit Nummer, danach unveränderlich", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/finance/out");
    const f = form(page, "Entwurf anlegen");
    await f.locator('select[name="customerId"]').selectOption({ label: `${customerNo} ${customerName}` });
    await f.getByLabel("Rechnungsdatum").fill(today);
    await f.getByLabel("Beschreibung 1").fill("Beratung");
    await f.getByLabel("Menge 1").fill("2");
    await f.getByLabel("Einzelpreis 1").fill("50");
    await f.getByLabel("Steuerkennzeichen 1").selectOption({ label: `${taxOut} (20 %)` });
    await f.getByRole("button", { name: "Entwurf anlegen" }).click();
    await page.waitForURL(/\/finance\/out\/[^/]+$/);
    await expect(page.getByText("120,00").first()).toBeVisible();
    await page.getByRole("button", { name: /Ausstellen/ }).click();
    await expect(page.getByRole("heading", { name: /^AR-\d{4}-\d{4}/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ausstellen/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Gutschrift anlegen" })).toBeVisible();
    await logout(page);
  });

  test("Export im BMD-Format: Vorschau, Lauf, Buchungsdatei und Belegpaket", async ({ page }) => {
    await login(page, "admin");
    await setProfile(page, "BMD");
    await page.goto("/finance/export");
    await expect(page.getByRole("heading", { name: "Prüfung" })).toBeVisible();
    await expect(page.getByText(`RE-${tag}-1`).or(page.getByText(supplierName)).first()).toBeVisible();
    const row = await runExport(page);
    const dataHref = await row.getByRole("link", { name: "Buchungsdatei" }).getAttribute("href");
    const data = await page.context().request.get(dataHref!);
    expect(data.status()).toBe(200);
    const csv = (await data.body()).toString("latin1");
    expect(csv.startsWith("satzart;konto;gkonto;belegnr;belegdatum;buchdat;betrag;")).toBe(true);
    expect(csv).toContain(`0;${vendorAcc};7000;`);
    expect(csv).toContain(`RE-${tag}-1`);
    expect(csv).toContain(`0;${debtorAcc};4000;`);
    expect(csv).toContain(";120,00;");
    const pkgHref = await row.getByRole("link", { name: "Belegpaket" }).getAttribute("href");
    const pkg = await page.context().request.get(pkgHref!);
    expect(pkg.status()).toBe(200);
    expect(pkg.headers()["content-type"]).toBe("application/zip");
    expect((await pkg.body()).subarray(0, 2).toString("latin1")).toBe("PK");
    // Direkt danach nichts mehr zu exportieren
    await page.goto("/finance/export");
    await expect(page.getByText("Nichts zu exportieren.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export erzeugen" })).toBeDisabled();
    await logout(page);
  });

  test("Export im DATEV-Format mit zweiter Eingangsrechnung", async ({ page }) => {
    await login(page, "admin");
    await setProfile(page, "DATEV");
    const url = await newSupplierInvoice(page, `RE-${tag}-2`, "200");
    await logout(page);
    await approveAsFinance(page, url);

    await login(page, "admin");
    const row = await runExport(page);
    const data = await page.context().request.get((await row.getByRole("link", { name: "Buchungsdatei" }).getAttribute("href"))!);
    expect(data.status()).toBe(200);
    const lines = (await data.body()).toString("latin1").split("\r\n");
    expect(lines[0]).toMatch(/^"EXTF";700;21;"Buchungsstapel";13;\d{17};;"BO";"";"";12345;67890;\d{8};4;/);
    expect(lines[1]!.split(";")).toHaveLength(125);
    const booking = lines.find((l) => l.includes(`RE-${tag}-2`))!;
    const f = booking.split(";");
    expect(f).toHaveLength(125);
    expect(f.slice(0, 2)).toEqual(["240,00", '"S"']);
    expect(f[6]).toBe("7000");
    expect(f[7]).toBe(vendorAcc);
    expect(f[8]).toBe('"9"');
    await logout(page);
  });

  test("Berechtigungen: nur Finanzen und Inhaber; Downloads sind geschützt", async ({ page }) => {
    for (const who of ["employee", "manager"] as const) {
      await login(page, who);
      for (const path of ["/finance", "/finance/in", "/finance/out", "/finance/export", "/finance/settings"]) {
        await page.goto(path);
        await expect(page.getByText("Dafür fehlt Ihnen die Berechtigung.")).toBeVisible();
      }
      expect((await page.context().request.get("/finance/export/download/irgendeine-id?part=data")).status()).toBe(403);
      expect((await page.context().request.get("/finance/files/irgendeine-id")).status()).toBe(403);
      await logout(page);
    }
    await page.context().clearCookies();
    const anon = await page.context().request.get("/finance/export/download/x", { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308]).toContain(anon.status()); // ohne Anmeldung zum Login umgeleitet
  });

  test("Audit-Log enthält Freigabe, Export und Download", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/audit");
    for (const action of ["supplier_invoice.approve", "customer_invoice.issue", "accounting.export", "accounting.download", "finance_file.upload"])
      await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible();
    await logout(page);
  });
});
