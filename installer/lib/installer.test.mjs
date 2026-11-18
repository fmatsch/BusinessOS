import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderEnv, parseEnv } from "./envfile.mjs";
import { cleanupPack, packApp } from "./pack.mjs";
import { randomPassword } from "./secrets.mjs";
import { buildStage, newSecrets } from "./ubuntu.mjs";
import { PROVISION_SH, renderBackupScript, renderNginx, renderParams, renderWebUnit, renderWorkerUnit } from "./ubuntu-script.mjs";
import { isDomain, isEmail, isHost, isPort, isText, isUnixUser, nodeOk, passwordProblem, shq } from "./validate.mjs";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Eingabeprüfung", () => {
  it("Hosts, Domains, E-Mail, Benutzer, Port", () => {
    for (const ok of ["192.168.1.10", "server.example.com", "srv-01", "::1", "2001:db8::1"]) expect(isHost(ok), ok).toBe(true);
    for (const bad of ["", "a b", "x;rm -rf /", "host$(id)", "256.1.1.256", "-bad.example", "a".repeat(300)]) expect(isHost(bad), bad).toBe(false);
    expect(isDomain("erp.beispiel.at")).toBe(true);
    for (const bad of ["ERP.example.com", "localhost", "a_b.example.com", "x.example.com; rm", "example"]) expect(isDomain(bad), bad).toBe(false);
    expect(isEmail("a.b+c@firma.example.at")).toBe(true);
    for (const bad of ["a@b", "a b@c.de", "a@b.c;d", "a'@b.de", "`x`@b.de"]) expect(isEmail(bad), bad).toBe(false);
    expect(isUnixUser("ubuntu")).toBe(true);
    expect(isUnixUser("Root")).toBe(false);
    expect(isUnixUser("a;b")).toBe(false);
    expect([isPort(22), isPort("443"), isPort(0), isPort(70000), isPort("22; ls")]).toEqual([true, true, false, false, false]);
    expect(isText("Muster GmbH")).toBe(true);
    expect(isText("zeile\nzwei")).toBe(false);
    expect(passwordProblem("kurz")).toMatch(/12/);
    expect(passwordProblem("langgenugpasswort")).toBeNull();
    expect(nodeOk("20.9.0")).toBe(true);
    expect(nodeOk("20.8.1")).toBe(false);
    expect(nodeOk("22.1.0")).toBe(true);
    expect(nodeOk("18.19.0")).toBe(false);
  });

  it("shq maskiert Hochkommas und lehnt Zeilenumbrüche ab", () => {
    expect(shq("a'b")).toBe("'a'\\''b'");
    expect(shq("$(id) `x` \"y\"")).toBe("'$(id) `x` \"y\"'");
    expect(() => shq("a\nb")).toThrow();
    // Der maskierte Wert wird von der Shell wieder zum Original (nur wenn bash vorhanden ist)
    const original = "it's $(echo x) \"q\" `y`";
    const r = spawnSync("bash", ["-c", `printf %s ${shq(original)}`], { encoding: "utf8" });
    if (!r.error && r.status === 0) expect(r.stdout).toBe(original);
  });
});

describe("Konfigurationsdateien und Geheimnisse", () => {
  it("renderEnv lässt nur sichere Werte zu", () => {
    expect(renderEnv({ A: "x", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db?schema=public" })).toBe("A=x\nDATABASE_URL=postgresql://u:p@127.0.0.1:5432/db?schema=public\n");
    expect(() => renderEnv({ A: "x\nB=y" })).toThrow();
    expect(() => renderEnv({ A: "$(id)" })).toThrow();
    expect(() => renderEnv({ A: 'x"y' })).toThrow();
    expect(() => renderEnv({ "a b": "x" })).toThrow();
    expect(parseEnv("A=1\n# c\nB=\"2\"\n")).toEqual({ A: "1", B: "2" });
  });

  it("Zufallspasswort hat alle Zeichenklassen und die gewünschte Länge", () => {
    for (let i = 0; i < 50; i++) {
      const p = randomPassword(20);
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/\d/); expect(p).toMatch(/[-_.+=]/);
      expect(passwordProblem(p)).toBeNull();
    }
    const s = newSecrets();
    expect(s.dbPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(s.authSecret.length).toBeGreaterThanOrEqual(43);
  });
});

describe("Ubuntu: erzeugte Dateien", () => {
  const admin = { email: "a@b.de", name: "O'Brien", password: "p'ass wörd $(id) 12345", orgName: "Muster & Söhne GmbH" };
  const base = { release: "20270101120000", domain: "", acmeEmail: "", sshPort: 22, enableUfw: true, host: "203.0.113.7", admin, secrets: newSecrets() };

  it("das Einrichtungsskript ist statisch, ohne Platzhalter-Reste, und syntaktisch gültiges bash", () => {
    expect(PROVISION_SH).not.toContain("\\${");
    expect(PROVISION_SH.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(PROVISION_SH).toContain("set -Eeuo pipefail");
    expect(PROVISION_SH).toContain("STAGE=\"${1:?Staging-Verzeichnis fehlt}\"");
    const f = path.join(os.tmpdir(), `bos-provision-${process.pid}.sh`);
    fs.writeFileSync(f, PROVISION_SH);
    const r = spawnSync("bash", ["-n", f], { encoding: "utf8" });
    fs.rmSync(f, { force: true });
    if (!r.error && r.status !== null) expect(r.stderr).toBe("");
  });

  it("Installation: env mit Geheimnissen, Administrator-Datei maskiert; Aktualisierung ohne beides", () => {
    const f = buildStage({ ...base, mode: "install" });
    expect(Object.keys(f).sort()).toEqual(["admin.env", "businessos-backup", "businessos-backup.service", "businessos-backup.timer", "businessos-worker.service", "businessos.service", "env", "nginx.conf", "params", "provision.sh"].sort());
    expect(f.env.mode).toBe(0o600);
    expect(f.env.data).toContain("DATABASE_URL=postgresql://businessos:");
    expect(f.env.data).toContain("AUTH_URL=http://203.0.113.7");
    expect(f["admin.env"].mode).toBe(0o600);
    expect(f["admin.env"].data).toContain("ADMIN_NAME='O'\\''Brien'");
    expect(f["admin.env"].data).toContain("ADMIN_PASSWORD='p'\\''ass wörd $(id) 12345'");
    const up = buildStage({ ...base, mode: "update", admin: undefined });
    expect(up.env).toBeUndefined();
    expect(up["admin.env"]).toBeUndefined();
    // Geheimnisse stehen nirgends sonst
    for (const [name, file] of Object.entries(f)) {
      if (["env", "admin.env"].includes(name)) continue;
      expect(file.data, name).not.toContain(base.secrets.dbPassword);
      expect(file.data, name).not.toContain(base.secrets.authSecret);
      expect(file.data, name).not.toContain(admin.password);
    }
  });

  it("Parameter: ungültige oder gefährliche Werte werden abgelehnt", () => {
    const ok = { mode: "install", release: "20270101120000", sshPort: 22, enableUfw: true };
    expect(renderParams(ok)).toContain("MODE='install'");
    expect(() => renderParams({ ...ok, mode: "x; rm -rf /" })).toThrow();
    expect(() => renderParams({ ...ok, release: "../../etc" })).toThrow();
    expect(() => renderParams({ ...ok, domain: "a.example.com; id", acmeEmail: "a@b.de" })).toThrow();
    expect(() => renderParams({ ...ok, domain: "erp.example.com" })).toThrow(/E-Mail/);
    expect(() => renderParams({ ...ok, sshPort: "22; ls" })).toThrow();
    expect(renderParams({ ...ok, domain: "erp.example.com", acmeEmail: "a@b.de" })).toContain("DOMAIN='erp.example.com'");
  });

  it("nginx und Dienste: Proxy nur lokal, Variablen bleiben für nginx erhalten, Härtung aktiv", () => {
    const n = renderNginx({ domain: "" });
    expect(n).toContain("default_server");
    expect(n).toContain("proxy_set_header Host $host;");
    expect(n).toContain("proxy_pass http://127.0.0.1:3000;");
    const d = renderNginx({ domain: "erp.example.com" });
    expect(d).not.toContain("default_server");
    expect(d).toContain("server_name erp.example.com;");
    expect(() => renderNginx({ domain: "x; evil" })).toThrow();
    for (const u of [renderWebUnit(), renderWorkerUnit()]) {
      expect(u).toContain("User=businessos");
      expect(u).toContain("NoNewPrivileges=true");
      expect(u).toContain("EnvironmentFile=/etc/businessos/env");
    }
    expect(renderWebUnit()).toContain("-H 127.0.0.1");
    expect(renderBackupScript()).toContain("pg_dump");
    expect(renderBackupScript()).toContain("-mtime +14");
  });
});

describe("Archiv der Anwendung", () => {
  it("enthält den Quellcode, aber keine Abhängigkeiten, Builds, Geheimnisse oder lokalen Daten", async () => {
    const p = await packApp(appDir);
    try {
      const r = spawnSync("tar", ["-tzf", "app.tar.gz"], { cwd: p.dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      expect(r.status).toBe(0);
      const names = r.stdout.split(/\r?\n/).map((l) => l.replace(/^\.\//, ""));
      for (const must of ["package.json", "prisma/schema.prisma", "scripts/create-admin.ts", "scripts/worker.ts", "src/platform/authz/permissions.ts"]) expect(names, must).toContain(must);
      expect(names.some((n) => /(^|\/)node_modules(\/|$)/.test(n))).toBe(false);
      expect(names.some((n) => /^\.next(\/|$)/.test(n))).toBe(false);
      expect(names.some((n) => /(^|\/)\.env$/.test(n))).toBe(false);
      expect(names.some((n) => /^\.git(\/|$)/.test(n))).toBe(false);
      expect(names.some((n) => /^data(\/|$)/.test(n))).toBe(false);
    } finally {
      cleanupPack(p);
    }
  }, 60_000);
});
