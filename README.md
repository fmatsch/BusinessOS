# BusinessOS – The Operating System for Business

Modulare, KI-native ERP-Plattform (Modular Monolith) mit Mandantenfähigkeit, RBAC, Audit-Log und Workflow-Engine.
Sprache der Oberfläche: Deutsch (Standard) und Englisch.

> **Status: Phase 4 (KI-Copilot, lesend).** Funktional sind Authentifizierung, Organisationen/Mandanten, Rollen & Rechte,
> App-Rahmen, Abteilungen, Kostenstellen, Lieferanten, Bestellanforderung mit Freigabe, Bestellung, Budget-Bindung, Benachrichtigungen, HR-Basis (Mitarbeiter, Beschäftigung, Urlaub, Abwesenheiten), Dienstplanung (Schichten, Regelprüfung, Versionen, Tausch, iCal), Zeiterfassung (Stempeluhr, Korrekturen mit Freigabe, Monatsabschluss, Zeitkonto), Audit-Log und ein lesender KI-Copilot (benötigt `ANTHROPIC_API_KEY`). Alle anderen Module erscheinen in der Navigation als *geplant* und täuschen keine Funktion vor.
> Siehe [ROADMAP.md](ROADMAP.md).

## Dokumentation

| Datei | Inhalt |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architektur, Modulgrenzen, Mandantenfähigkeit, Events, KI |
| [DATABASE.md](DATABASE.md) | Datenmodell und Konventionen |
| [ROADMAP.md](ROADMAP.md) | Meilensteine und Risiken |
| [MODULES.md](MODULES.md) | Plan für Dienstplanung, Zeiterfassung, Abrechnung und weitere Module |
| [SECURITY.md](SECURITY.md) | Sicherheitskonzept |
| [CLAUDE.md](CLAUDE.md) | Konventionen für künftige Claude-Code-Sitzungen |

## Stack

Next.js (App Router) · React · TypeScript (strict) · Tailwind CSS · Prisma · PostgreSQL · Zod · Auth.js · Docker Compose

## Lokal starten

Voraussetzungen: Node.js 20+ und Docker.

```bash
cp .env.example .env          # Werte anpassen, AUTH_SECRET erzeugen: npx auth secret
docker compose up -d db       # PostgreSQL
npm install
npx prisma migrate dev        # Schema anlegen
npm run db:seed               # Demo-Daten (rein synthetisch)
# Ohne Docker: npm run db:dev startet eine lokale PostgreSQL (Port 54329), nur für Entwicklung
npm run dev                   # http://localhost:3000
npm run worker                # optional: Hintergrundprozess für Events/Benachrichtigungen (Fallback zu after())
```

Demo-Login steht in `prisma/seed.ts` (synthetische Daten, nur für lokale Entwicklung).

## Tests

```bash
npm run typecheck
npm test            # Unit- und Integrationstests (Integrationstests brauchen DATABASE_URL, sonst übersprungen)
npm run build && npm run test:e2e   # Browser-Tests (Playwright); lokal mit installiertem Chrome: PW_CHANNEL=chrome
```

Für `test:e2e` muss die Datenbank migriert und mit `npm run db:seed` befüllt sein; `SEED_DEMO_PASSWORD` muss gesetzt sein.

## Projektseite

<https://fmatsch.github.io/BusinessOS/> – statische Vorstellung (Ordner `docs/`). Die Anwendung selbst benötigt Server und Datenbank und läuft nicht auf GitHub Pages.
