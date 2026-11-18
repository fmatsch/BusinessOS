# Roadmap

Legende: ✅ fertig und verifiziert · 🚧 in Arbeit · ⬜ geplant

## Phase 1 – Architektur
* ✅ README, ARCHITECTURE, DATABASE, ROADMAP, SECURITY, CLAUDE

## Phase 2 – Foundation
* ✅ Projektstruktur, Docker Compose (PostgreSQL), Prisma-Schema + Migrationen
* ✅ Authentifizierung (Auth.js Credentials, bcrypt, Rate Limit) – Login im Browser verifiziert
* ✅ Organisationen, Mitgliedschaften, Organization-Switcher (Mitgliedschaft serverseitig geprüft)
* ✅ RBAC mit Systemrollen, `authorize()` in jedem Service
* ✅ Audit-Log (in der Transaktion geschrieben, Ansicht `/audit`)
* ✅ App-Rahmen (Sidebar, Topbar, DE/EN), geplante Module klar gekennzeichnet
* ✅ Abteilungen und Kostenstellen (Anlegen/Listen)
* ⬜ Dark-Mode-Umschalter, Command Palette, Bearbeiten/Deaktivieren von Stammdaten

## Phase 3 – Funktionaler MVP (Beschaffung & Budget)
* ✅ Lieferanten
* ✅ Bestellanforderung → Freigabe (Führungskraft; über 5.000 € zusätzlich Finanzen) → Bestellung → Kostenstelle → gebundenes Budget → Dashboard
* ✅ Budgets je Kostenstelle und Jahr; gebunden = Summe der Bestellungen (abgeleitet); Überschreitung wird angezeigt und im Audit-Log vermerkt
* ✅ Keine Selbstfreigabe, keine Doppelbestellung, parallele Entscheidungen sicher (Test)
* ⚠️ Freigabeschwelle ist eine Konstante (`rules.ts`), noch keine versionierte Workflow-Definition
* ⚠️ Outbox-Events werden geschrieben, aber noch nicht von einem Dispatcher verarbeitet; keine Benachrichtigungen
* ⚠️ Über-Budget-Bestellungen werden zugelassen (nur Warnung), kein Sperr-Workflow
* ⚠️ Neue Seiten haben deutsche Texte direkt im Code, nicht über i18n

## Phase 4 – KI
* ⬜ Provider-Abstraktion, Claude-Anbindung
* ⬜ Lesende, berechtigungsgeprüfte Tools mit Quellenangabe

## Phase 5 – Tests & Härtung
* ⬜ Unit-, Integrations-, E2E-Tests, Tenant-Isolation, Autorisierung, Finanzkonsistenz, Barrierefreiheit

## Danach
Finance (Doppik), Wareneingang & Rechnungsabgleich, Inventar, HR, Projekte, CRM, Workflow-Designer, Integrationen.
