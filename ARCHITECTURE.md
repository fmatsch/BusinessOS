# Architektur

## Entscheidungen

| Entscheidung | Begründung | Tradeoff |
|---|---|---|
| **Modularer Monolith** in einer Next.js-App | Ein Deployment, Transaktionen über Module, geringe Betriebskosten | Modulgrenzen müssen per Konvention und Lint erzwungen werden |
| **Server-seitige Services** statt Logik in Route-Handlern | Gleiche Geschäftslogik für UI (Server Actions), REST und KI-Tools | Etwas mehr Struktur |
| **Tenant-Scoping per Pflicht-Kontext** (`TenantContext`) in jedem Service | Isolation lässt sich nicht „vergessen"; getestet | Kein DB-seitiges Row-Level-Security im MVP (siehe Risiken) |
| **Auth.js (Credentials + JWT-Sessions)** | Wartung, Next.js-Integration | Credentials-Provider hat kein eingebautes Rate Limiting → selbst ergänzt |
| **Prisma + PostgreSQL**, `Decimal` für Geld | Migrationen, Typsicherheit | Prisma-Transaktionen sind interaktiv, aber ohne Savepoint-API |
| **Transactional Outbox** für Domain Events | Konsistenz zwischen Daten und Events/Workflows | Poller/Worker nötig (im MVP in-process) |
| **KI nur über Tools** | Keine beliebigen SQL-Abfragen, Berechtigungen prüfbar | Weniger flexibel als freie Abfragen |

## Schichten

```
src/
  app/                 Next.js-Routen (UI + dünne API-Handler), keine Geschäftslogik
  modules/<domain>/    Je Domäne: schema.ts (Zod) · service.ts · queries.ts · events.ts · components/ · *.test.ts
  platform/            Querschnitt: auth, tenancy, authz, audit, events, notifications, workflow, ai, files
  components/ui/       Design-System (shadcn/ui-Stil)
  lib/                 Hilfsfunktionen (money, i18n, env)
prisma/                schema.prisma, Migrationen, seed.ts
```

### Modulgrenzen
* Ein Modul spricht andere Module nur über deren `service.ts` oder `queries.ts` an oder reagiert auf Domain Events.
* `platform/*` darf von allen genutzt werden, importiert aber keine Fach-Module.
* Erzwungen durch `src/architecture.test.ts` (kein ESLint).

### Request-Fluss
1. Route / Server Action ruft `requireContext()` → liefert `{ userId, organizationId, permissions }` aus Session + Mitgliedschaft (immer frisch aus der DB geprüft, nicht blind aus dem Token).
2. `authorize(ctx, "procurement.request.approve")` – serverseitig, ausdrücklich in jeder Operation.
3. Service validiert mit Zod, öffnet eine Transaktion, schreibt Daten **und** AuditLog **und** Outbox-Event atomar.
4. Alle Queries enthalten `organizationId: ctx.organizationId`.

## Mandantenfähigkeit
* **Tenant** = Kunde/Vertragspartner, **Organization** = Gesellschaft innerhalb eines Tenants. Ein User kann Mitglied mehrerer Organisationen sein (`OrganizationMembership`), Wechsel über den Organization-Switcher.
* Jede fachliche Tabelle trägt `organizationId`. Zugriff erfolgt ausschließlich über Repository-Funktionen, die den Kontext verlangen.
* Cross-Tenant-Tests: für jeden Service wird mit Kontext der Organisation B auf Datensätze von A zugegriffen; erwartet wird „nicht gefunden".

## Autorisierung
* Permissions als Strings `modul.ressource.aktion` (z. B. `procurement.request.approve`).
* Rollen sind pro Organisation definiert (Systemrollen + eigene), `Role` ↔ `Permission` n:m.
* Sensible HR-Daten haben eigene Permissions (`hr.employee.read_sensitive`), nicht in der Standard-Mitarbeiterrolle enthalten.
* Policy-Erweiterung: `authorize` kann zusätzlich Bedingungen prüfen (z. B. Betragsgrenze, eigener Datensatz).

## Domain Events & Outbox
`OutboxEvent` wird in derselben Transaktion wie die Änderung geschrieben. `platform/events/dispatcher.ts` holt fällige Events mit `FOR UPDATE SKIP LOCKED`, führt die Handler (registriert in `modules/events.ts`) in einer Transaktion mit Savepoint aus, wiederholt mit exponentiellem Backoff und markiert nach 5 Fehlversuchen als fehlgeschlagen. „Mindestens einmal" – Handler müssen idempotent sein (z. B. `dedupeKey` bei Benachrichtigungen). Auslöser: `after()` nach Aktionen plus `npm run worker`.

## Genehmigungen
`platform/approvals`: versionierte Regel je Organisation und Objektart (`ApprovalPolicy`), Schritte mit Berechtigung und optionalem Mindestbetrag. Beim Einreichen werden die nötigen Schritte samt Berechtigung als Schnappschuss in `Approval` gespeichert; spätere Regeländerungen betreffen nur neue Vorgänge.

## Workflow-Engine (Phase 3)
* `WorkflowDefinition` ist versioniert (unveränderliche Versionen, neue Version bei Änderung).
* `WorkflowInstance` referenziert genau eine Version.
* Schritte: Bedingung, Genehmigung, Aufgabe, Benachrichtigung. Jeder Übergang → AuditLog.
* Beispiel: Antrag > 5.000 € → zusätzlicher Genehmigungsschritt Finance.

## Finanz-Integrität
* Geld: `Decimal(19,4)` + Währungscode, Berechnung mit `decimal.js`, nie `number`.
* Gebuchte Journale sind unveränderlich; Korrektur über Storno-Buchung (`reversesId`). Datenbank-Trigger verhindern UPDATE/DELETE auf gebuchten Zeilen (ab Finance-Modul).
* Soll = Haben wird im Service und per Constraint-Check geprüft.
* MVP-Budget: *committed* (Bestellungen) und *requested* werden aus Bestellungen abgeleitet, nicht manuell gepflegt.

## KI-Copilot (Phase 4)
* `AiProvider`-Interface; erste Implementierung Anthropic Claude.
* Tools sind typisierte Funktionen mit Zod-Schema, jede ruft denselben Service-Layer mit dem Kontext des Benutzers (kein Service-Konto).
* Nur lesende Tools im MVP; schreibende Tools erzeugen einen **Vorschlag**, der erst nach Bestätigung durch den Benutzer ausgeführt wird.
* Antworten nennen Quelldatensätze; Schätzungen werden gekennzeichnet.
* Dokumentinhalte gelten als nicht vertrauenswürdig (Prompt Injection): sie werden als Daten markiert, Tool-Aufrufe werden nie aus Daten abgeleitet.
* Jeder Tool-Aufruf → AuditLog (`actor = AI on behalf of user`).

## Internationalisierung
Wörterbücher `de`/`en` unter `src/lib/i18n`, Standard `de`. Beträge/Datum über `Intl` mit Zeitzone der Organisation.

## Risiken
| Risiko | Gegenmaßnahme |
|---|---|
| Vergessener `organizationId`-Filter | Pflicht-Kontext, Cross-Tenant-Tests, später Postgres RLS als zweite Schicht |
| Zu großer Umfang | Strikte Phasen, ein End-to-End-Prozess zuerst |
| Credentials-Brute-Force | Rate Limit, Argon2/bcrypt, Sperre nach Fehlversuchen |
| Prompt Injection / Datenabfluss über KI | Tool-Allowlist, Berechtigungsprüfung, Bestätigungspflicht |
| Outbox ohne Worker im MVP | In-process-Dispatcher, später separater Worker |
| Abhängigkeits-Inkompatibilität (Next/Auth.js/Prisma) | Versionen beim Setup prüfen, in `package.json` fixieren |
