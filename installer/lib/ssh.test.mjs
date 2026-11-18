import { afterAll, beforeAll, describe, expect, it } from "vitest";
// ssh2 liegt im Installer-Ordner (npm install dort); ohne die Bibliothek werden diese Tests übersprungen.
let ssh2 = null, fingerprintOf, SshSession;
try { ssh2 = (await import("ssh2")).default; ({ fingerprintOf, SshSession } = await import("./ssh.mjs")); } catch { /* nicht installiert */ }
const { Server, utils } = ssh2 ?? {};

// Ein kleiner SSH-Server in-process: Passwortanmeldung, exec mit Standardeingabe und Exitcode. Prüft nur die Client-Logik des Installers.
describe.skipIf(!ssh2)("SSH-Sitzung (Test-Server)", () => {
  let server, port, hostKey, publicKey;
  const seen = [];

  beforeAll(async () => {
    const pair = utils.generateKeyPairSync("ed25519");
    hostKey = pair.private;
    publicKey = utils.parseKey(pair.public);
    server = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on("error", () => { /* Client bricht absichtlich ab (Host-Schlüssel abgelehnt) */ });
      client.on("authentication", (ctx) => (ctx.method === "password" && ctx.username === "tester" && ctx.password === "geheim-123" ? ctx.accept() : ctx.reject(["password"])));
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            seen.push(info.command);
            let input = "";
            stream.on("data", (d) => { input += d.toString(); });
            stream.on("end", () => {
              if (info.command === "id -u") stream.write("1000\n");
              else if (info.command.startsWith("sudo -S -p '' ")) {
                if (input === "sudo-geheim\n") { stream.write("ok " + info.command.slice(14) + "\n"); stream.exit(0); } else { stream.stderr.write("sudo: Authentifizierung fehlgeschlagen\n"); stream.exit(1); }
                stream.end();
                return;
              } else stream.write("unbekannt\n");
              stream.exit(0);
              stream.end();
            });
          });
        });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    port = server.address().port;
  });
  afterAll(() => server.close());

  it("Host-Schlüssel muss bestätigt werden; der Fingerabdruck stimmt mit dem Schlüssel überein", async () => {
    const s = new SshSession();
    let shown = "";
    await s.connect({ host: "127.0.0.1", port, username: "tester", password: "geheim-123", confirmHostKey: async (fp) => { shown = fp; return true; } });
    expect(shown).toBe(fingerprintOf(publicKey.getPublicSSH()));
    expect(shown).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    const r = await s.exec("id -u");
    expect(r).toMatchObject({ code: 0, out: "1000\n" });
    s.close();
  });

  it("abgelehnter Fingerabdruck bricht die Verbindung ab, bevor Zugangsdaten gesendet werden", async () => {
    const s = new SshSession();
    await expect(s.connect({ host: "127.0.0.1", port, username: "tester", password: "geheim-123", confirmHostKey: async () => false })).rejects.toThrow();
    s.close();
  });

  it("falsches Passwort wird abgewiesen", async () => {
    const s = new SshSession();
    await expect(s.connect({ host: "127.0.0.1", port, username: "tester", password: "falsch", confirmHostKey: async () => true })).rejects.toThrow();
    s.close();
  });

  it("sudo-Passwort geht über die Standardeingabe, nie in die Befehlszeile; Fehler liefern Exitcode", async () => {
    const s = new SshSession();
    await s.connect({ host: "127.0.0.1", port, username: "tester", password: "geheim-123", confirmHostKey: async () => true });
    const ok = await s.exec("sudo -S -p '' true", { stdin: "sudo-geheim\n" });
    expect(ok.code).toBe(0);
    const bad = await s.exec("sudo -S -p '' true", { stdin: "falsch\n" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("fehlgeschlagen");
    expect(seen.some((c) => c.includes("geheim"))).toBe(false);
    s.close();
  });
});
