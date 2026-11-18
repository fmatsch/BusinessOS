// Eingaben im Terminal: Fragen mit Standardwert, Auswahl, Ja/Nein und verdeckte Passworteingabe. Ohne Terminal (kein TTY) wird nie geraten.
import readline from "node:readline";

export class Prompter {
  constructor({ input = process.stdin, output = process.stdout, interactive = Boolean(process.stdin.isTTY) } = {}) {
    this.input = input;
    this.output = output;
    this.interactive = interactive;
  }

  #rl() { return readline.createInterface({ input: this.input, output: this.output, terminal: false }); }

  write(s) { this.output.write(s); }
  line(s = "") { this.output.write(s + "\n"); }

  #need(what) {
    if (!this.interactive) throw new Error(`Eingabe nötig (${what}), aber kein Terminal verfügbar. Bitte per Parameter angeben (siehe README).`);
  }

  async ask(question, { def, validate } = {}) {
    this.#need(question);
    for (;;) {
      const rl = this.#rl();
      const answer = await new Promise((res) => rl.question(`${question}${def !== undefined && def !== "" ? ` [${def}]` : ""}: `, res));
      rl.close();
      const v = answer.trim() === "" && def !== undefined ? String(def) : answer.trim();
      const problem = validate ? validate(v) : null;
      if (!problem) return v;
      this.line(`  → ${problem}`);
    }
  }

  async confirm(question, def = true) {
    this.#need(question);
    for (;;) {
      const rl = this.#rl();
      const a = await new Promise((res) => rl.question(`${question} [${def ? "J/n" : "j/N"}]: `, res));
      rl.close();
      const t = a.trim().toLowerCase();
      if (t === "") return def;
      if (["j", "ja", "y", "yes"].includes(t)) return true;
      if (["n", "nein", "no"].includes(t)) return false;
      this.line("  → Bitte „j“ oder „n“ eingeben.");
    }
  }

  async choose(question, options) {
    this.#need(question);
    this.line(question);
    options.forEach((o, i) => this.line(`  ${i + 1}) ${o.label}`));
    for (;;) {
      const rl = this.#rl();
      const a = await new Promise((res) => rl.question(`Auswahl [1-${options.length}]: `, res));
      rl.close();
      const n = Number(a.trim());
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
      this.line("  → Bitte eine der Zahlen eingeben.");
    }
  }

  /** Passwort ohne Anzeige der Zeichen (Raw-Modus). */
  async secret(question, { validate } = {}) {
    this.#need(question);
    for (;;) {
      const v = await this.#readHidden(`${question}: `);
      const problem = validate ? validate(v) : null;
      if (!problem) return v;
      this.line(`  → ${problem}`);
    }
  }

  #readHidden(label) {
    return new Promise((resolve, reject) => {
      const stdin = this.input;
      if (typeof stdin.setRawMode !== "function") { reject(new Error("Verdeckte Eingabe ist in diesem Terminal nicht möglich.")); return; }
      this.write(label);
      let buf = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const done = (fn) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); this.write("\n"); fn(); };
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") return done(() => resolve(buf));
          if (ch === "\u0003") return done(() => reject(new Error("Abgebrochen")));
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else if (ch >= " ") buf += ch;
        }
      };
      stdin.on("data", onData);
    });
  }
}
