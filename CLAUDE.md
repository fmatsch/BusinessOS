# CLAUDE.md – Konventionen für BusinessOS

## Überblick
Modularer Monolith: Next.js (App Router) + TypeScript strict + Prisma/PostgreSQL + Auth.js + Zod. Details: ARCHITECTURE.md, DATABASE.md.

## Befehle
* `npm run dev` – Entwicklung · `npm run typecheck` · `npm test` · `npm run test:e2e` (nach `npm run build`)
* `docker compose up -d db` – lokale Datenbank
* `npx prisma migrate dev` · `npm run db:seed`

## Verbindliche Regeln
1. **Tenant-Isolation**: Jeder Service nimmt einen `Ctx` (aus `requireContext()`) und filtert immer nach `ctx.organizationId`. Nie `organizationId` aus Request-Daten übernehmen.
2. **Autorisierung**: `authorize(ctx, permission)` am Anfang jeder Service-Funktion. Neue Permissions in `src/platform/authz/permissions.ts` registrieren.
3. **Keine Geschäftslogik in Routen/Komponenten** – nur in `modules/<domain>/service.ts`.
4. **Modulgrenzen**: andere Module nur über `service.ts`/`queries.ts` ansprechen; `platform/` importiert keine Fachmodule (erzwungen in `src/architecture.test.ts`).
5. **Geld** immer `Decimal` (`decimal.js`/Prisma), nie `number`.
6. **Events**: Handler sind idempotent (dedupeKey) und lesen nur innerhalb `event.organizationId`; Freigaben laufen über `platform/approvals` (nie feste Schwellen im Code).
6a. **Schreibende Operationen** laufen in `prisma.$transaction` und schreiben AuditLog + ggf. OutboxEvent atomar.
7. **Gebuchte Finanzdaten** nie ändern/löschen – Storno-Buchung.
8. **Validierung** mit Zod an jeder Eingabegrenze.
9. **KI** nur über Tools, die Services mit Benutzerkontext aufrufen; nie freies SQL; Änderungen nur nach Bestätigung.
10. **Keine Secrets im Code**; neue Variablen in `.env.example` dokumentieren.
11. **UI-Texte** über i18n (`de` Standard, `en`). Nicht implementierte Module klar als „geplant" kennzeichnen.
12. **Keine Behauptung ohne Verifikation**: Features erst als fertig melden, wenn Tests/Typecheck laufen.
13. Demo-Daten nur synthetisch.

## Stil
Kleine, klare Funktionen; keine unnötigen Abhängigkeiten; Tests neben dem Code (`*.test.ts`, Vitest).
