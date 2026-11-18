// SSH/SFTP-Zugriff auf den Server (Bibliothek ssh2). Der Host-Schlüssel wird vor der Anmeldung angezeigt und muss bestätigt werden;
// Passwörter werden nie in Befehlszeilen oder Protokolle geschrieben (sudo erhält sie über die Standardeingabe).
import { Client } from "ssh2";
import { createHash } from "node:crypto";
import fs from "node:fs";

export const fingerprintOf = (hostKey) => "SHA256:" + createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");

export class SshSession {
  #client = new Client();
  #sftp = null;

  /**
   * @param {object} o host, port, username, password?, privateKey?(Pfad), passphrase?
   * @param {(fingerprint:string)=>Promise<boolean>} o.confirmHostKey  Rückfrage zum Fingerabdruck; false bricht ab
   */
  async connect(o) {
    const cfg = { host: o.host, port: o.port, username: o.username, readyTimeout: 30_000, keepaliveInterval: 15_000 };
    if (o.privateKey) cfg.privateKey = fs.readFileSync(o.privateKey);
    if (o.passphrase) cfg.passphrase = o.passphrase;
    if (o.password) cfg.password = o.password;
    cfg.hostVerifier = (key, verify) => {
      const fp = fingerprintOf(key);
      Promise.resolve(o.confirmHostKey(fp)).then((ok) => verify(Boolean(ok)), () => verify(false));
    };
    await new Promise((resolve, reject) => {
      this.#client.once("ready", resolve).once("error", reject);
      this.#client.connect(cfg);
    });
  }

  /** Führt einen Befehl aus; `stdin` wird geschrieben und die Eingabe danach geschlossen. Rückgabe: Exitcode und Ausgabe. */
  exec(command, { stdin, onOutput } = {}) {
    return new Promise((resolve, reject) => {
      this.#client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        const on = (d) => { const s = d.toString("utf8"); out += s; onOutput?.(s); };
        stream.on("data", on);
        stream.stderr.on("data", on);
        stream.on("close", (code) => resolve({ code: code ?? 1, out }));
        if (stdin !== undefined) stream.write(stdin);
        stream.end();
      });
    });
  }

  async #sftpClient() {
    if (this.#sftp) return this.#sftp;
    this.#sftp = await new Promise((resolve, reject) => this.#client.sftp((e, s) => (e ? reject(e) : resolve(s))));
    return this.#sftp;
  }

  /** Datei (Pfad oder Text/Buffer) hochladen, mit Dateimodus. */
  async upload(source, remotePath, mode = 0o600) {
    const sftp = await this.#sftpClient();
    if (typeof source === "string" && fs.existsSync(source)) {
      await new Promise((resolve, reject) => sftp.fastPut(source, remotePath, { mode }, (e) => (e ? reject(e) : resolve())));
    } else {
      await new Promise((resolve, reject) => {
        const ws = sftp.createWriteStream(remotePath, { mode });
        ws.on("close", resolve).on("error", reject);
        ws.end(Buffer.isBuffer(source) ? source : Buffer.from(String(source), "utf8"));
      });
    }
  }

  close() { try { this.#client.end(); } catch { /* bereits geschlossen */ } }
}
