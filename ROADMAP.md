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

## Phase 4 – KI (lesend)
* ✅ Anbieterunabhängige Schnittstelle (`platform/ai/provider.ts`), Claude als erster Anbieter (Standardmodell `claude-opus-5-5`, per `AI_MODEL` änderbar)
* ✅ 8 nur lesende, berechtigungsgeprüfte Werkzeuge (Anforderungen, Freigaben, Budgets, Abteilungsvolumen, Lieferanten, Kostenstellen, Abteilungen) – kein freies SQL, kein Service-Konto
* ✅ Quellen werden serverseitig aus Werkzeugergebnissen abgeleitet, nicht vom Modell behauptet
* ✅ Jede Frage, jeder Werkzeugaufruf und jede Antwort im Audit-Log (`actorType = AI`, im Auftrag des Benutzers)
* ✅ Prompt-Injection: Daten als `<untrusted_data>` gekapselt, Strings gekürzt, keine Schreib-Werkzeuge vorhanden, nicht angebotene Werkzeuge werden abgelehnt (Tests)
* ✅ Rate-Limit 20 Fragen/Stunde/Benutzer, max. 6 Werkzeugschritte pro Frage
* ⚠️ **Nicht gegen die echte Claude-API verifiziert** (kein API-Schlüssel hinterlegt): getestet mit Fake-Anbieter und Attrappe des SDK-Clients
* ⚠️ Kein Gesprächsverlauf (jede Frage einzeln); keine Streaming-Ausgabe; keine Fragen zu Rechnungen/Personal/Lager/CRM (Module fehlen)
* ⬜ Schreibende Werkzeuge nur als Vorschlag mit Bestätigung durch den Benutzer

## Phase 5 – Tests & Härtung
* ⬜ Unit-, Integrations-, E2E-Tests, Tenant-Isolation, Autorisierung, Finanzkonsistenz, Barrierefreiheit

## Danach
Finance (Doppik), Wareneingang & Rechnungsabgleich, Inventar, HR, Projekte, CRM, Workflow-Designer, Integrationen.
