// Packt den Quellcode der Anwendung (ohne Abhängigkeiten, Build, Geheimnisse, Installer-Daten) als .tar.gz.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXCLUDES = [".git", "node_modules", ".next", ".env", ".env.local", "installer/node_modules", "test-results", "playwright-report", "coverage", ".claude", "./data", "tsconfig.tsbuildinfo", "*.log"];

/** Erzeugt das Archiv in einem neuen temporären Ordner und liefert dessen Pfad. Nutzt das System-`tar` (Windows 10+, macOS, Linux). */
export async function packApp(appDir) {
  if (!fs.existsSync(path.join(appDir, "package.json")) || !fs.existsSync(path.join(appDir, "prisma", "schema.prisma"))) throw new Error(`Kein BusinessOS-Projektordner: ${appDir}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bos-pack-"));
  const file = path.join(dir, "app.tar.gz");
  // Relativer Ausgabename im Arbeitsordner: GNU tar (z. B. Git Bash unter Windows) hielte „C:\…“ sonst für einen Rechnernamen
  const args = ["-czf", "app.tar.gz", ...EXCLUDES.flatMap((e) => ["--exclude", e]), "-C", appDir, "."];
  await new Promise((resolve, reject) => {
    const p = spawn("tar", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => reject(new Error(`tar nicht verfügbar: ${e.message}`)));
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar fehlgeschlagen (${code}): ${err.slice(0, 300)}`))));
  });
  return { file, dir, size: fs.statSync(file).size };
}

export function cleanupPack(p) { try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch { /* egal */ } }
