// .env-/EnvironmentFile-Dateien: nur sichere Werte (systemd, dotenv und Shell lesen sie gleich). Alles andere wird abgelehnt.
const KEY = /^[A-Z][A-Z0-9_]*$/;
const SAFE_VALUE = /^[A-Za-z0-9._~:/@%+=,?&#-]*$/;

export function renderEnv(values) {
  const lines = [];
  for (const [k, v] of Object.entries(values)) {
    if (!KEY.test(k)) throw new Error(`Ungültiger Schlüssel: ${k}`);
    const s = String(v ?? "");
    if (!SAFE_VALUE.test(s)) throw new Error(`Wert für ${k} enthält unzulässige Zeichen`);
    lines.push(`${k}=${s}`);
  }
  return lines.join("\n") + "\n";
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return out;
}
