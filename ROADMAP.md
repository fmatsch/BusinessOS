# Roadmap

Legende: ✅ fertig und verifiziert · 🚧 in Arbeit · ⬜ geplant

## Phase 1 – Architektur
* ✅ README, ARCHITECTURE, DATABASE, ROADMAP, SECURITY, CLAUDE

## Phase 2 – Foundation
* ✅ Projektstruktur, Docker Compose (PostgreSQL), Prisma-Schema + Init-Migration
* ✅ Authentifizierung (Auth.js Credentials, bcrypt, Rate Limit)
* ✅ Organisationen, Mitgliedschaften, Organization-Switcher (Mitgliedschaft serverseitig geprüft)
* ✅ RBAC mit Systemrollen, `authorize()` in jedem Service
* ✅ Audit-Log-Grundlage (Schreiben in der Transaktion, Anzeige im Dashboard)
* ✅ App-Rahmen (Sidebar, Topbar, DE/EN), geplante Module klar gekennzeichnet
* ✅ Abteilungen und Kostenstellen (Anlegen/Listen)
* ⚠️ Nicht gegen eine echte Datenbank verifiziert (Docker fehlt auf dem Entwicklungsrechner): Migration, Seed, Login-Ablauf, Tenant-Isolationstest (läuft in CI)
* ⬜ Dark-Mode-Umschalter, Command Palette, Bearbeiten/Deaktivieren von Stammdaten

## Phase 3 – Funktionaler MVP (Beschaffung & Budget)
* ⬜ Lieferanten
* ⬜ Bestellanforderung → Genehmigung (Schwelle 5.000 € ⇒ Finance) → Bestellung → Kostenstelle → Budget (committed)
* ⬜ Dashboard mit echten Kennzahlen, Audit-Log-Ansicht

## Phase 4 – KI
* ⬜ Provider-Abstraktion, Claude-Anbindung
* ⬜ Lesende, berechtigungsgeprüfte Tools mit Quellenangabe

## Phase 5 – Tests & Härtung
* ⬜ Unit-, Integrations-, E2E-Tests, Tenant-Isolation, Autorisierung, Finanzkonsistenz, Barrierefreiheit

## Danach
Finance (Doppik), Wareneingang & Rechnungsabgleich, Inventar, HR, Projekte, CRM, Workflow-Designer, Integrationen.
