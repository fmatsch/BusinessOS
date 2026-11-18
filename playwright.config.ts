import { defineConfig } from "@playwright/test";
import fs from "node:fs";

// .env für den Testprozess laden (der Next-Server liest sie selbst)
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(?:"(.*)"|(.*))$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2] ?? m[3];
  }
}

const port = 3100;
export default defineConfig({
  testDir: "tests/e2e",
  workers: 1, // gemeinsame Datenbank, Szenarien bauen aufeinander auf
  timeout: 60_000,
  // Die Finanz-Einstellungen rendern bei vielen angesammelten Testdaten (Konten × Kunden × Auswahllisten) mehrere Sekunden
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    // Lokal mit installiertem Chrome (PW_CHANNEL=chrome), in CI mit Playwright-Chromium
    channel: process.env.PW_CHANNEL || undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx next start -p ${port}`,
    url: `http://localhost:${port}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
