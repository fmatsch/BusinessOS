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
9. **KI** nur über Tools, die Services mit Benutzerkontext aufrufen; nie freies SQL; Änderungen nur als Vorschlag (`AiWriteTool`, `propose_*`) und erst nach Bestätigung der Person ausführen; nie Freigaben, Löschungen oder Zahlungen als KI-Werkzeug.
10. **Keine Secrets im Code**; neue Variablen in `.env.example` dokumentieren.
10a. **HR**: sensible Felder nur über `readSensitive` (protokolliert); Salden nur als Journal (nie Zahlen überschreiben); Abwesenheitsdaten ohne Diagnosen; Zeilensperre `lockEmployee` bei Buchungen je Mitarbeiter.
10b. **Dienstplan**: Regeln nur über `modules/roster/rules.ts` (rein, getestet); Zeiten als UTC speichern, Dauern aus UTC berechnen; veröffentlichte Versionen nie ändern (neue Version erzeugen); Mitarbeiter sehen nur `PublishedShift`, nie die Arbeitskopie.
10c. **Zeiterfassung**: Buchungen nie ändern – Gegenbuchung (`reverseEntry`) + neue Buchung; gesperrte Monate (APPROVED) nie beschreiben; Zeitdaten anderer Personen nur über `getEmployeeTime` (protokolliert); Zeitkonto nur als Journal.
10d. **Lohn-Export**: nur erfasste Mengen exportieren, keine Entgeltberechnung; Läufe nie ändern – Korrekturen als Nachtrag (Differenz); Zahlenfelder nie formelgeschützt, Textfelder immer (`csvField`).
10e. **Finance**: gebuchte/exportierte Belege nie ändern – Gutschrift; Exportläufe unveränderlich, jeder Beleg höchstens einmal; Uploads nur per Inhaltsprüfung; Eingangsrechnungen nur mit Vier-Augen-Freigabe; Steuer nur über `finance/tax.ts`; Aussteller-Angaben im PDF nur aus dem Snapshot am Beleg (`issuerSnapshot`), nie aus dem aktuellen Profil.
10f. **Wareneingang/Abgleich**: Wareneingänge nie ändern – Gegenbuchung; Abgleich nur über `finance/match.ts` (rein, getestet); Rechnungsfreigabe mit Abweichung nur nach Akzeptieren mit Begründung.
10g. **CRM/Angebote**: Angebote nie bearbeiten (Kopie); Versand nur nach Freigabe laut Regel `QUOTE`; Aktivitäten nie ändern; Personendaten nie ins Audit-Log; Löschwunsch nur per `anonymizeContact`.
10h. **Projekte**: Projektzeiten nie ändern (Gegenbuchung); abgerechnete Zeiten nie korrigieren (Gutschrift); Abrechnung nur über `billProject` (Projektsperre, Rechnungsentwurf über Finance-Service); Verrechnungssatz nur für `project.manage`/`project.bill` sichtbar.
10i. **Bankabgleich**: Auszüge nur über `finance/bank.ts` lesen (rein, getestet); Zuordnung nur mit exaktem Betrag und in einer Transaktion mit dem Zahlungsvermerk; keine automatische Zuordnung ohne Belegnummer.
10j. **Spesen**: eingereichte Abrechnungen nie ändern; Freigabe nur über die Regel `EXPENSE_REPORT`; nie die eigene Abrechnung freigeben; Beleg-Zugriff nur über `getExpenseReceipt` (Sichtbarkeitsprüfung).
10k. **Lager**: Bestand nur als Summe des Journals; Bewegungen nie ändern (Gegenbuchung); Buchungen je Artikel unter Zeilensperre, nie negativer Bestand; Wareneingänge nur über `stockReceiptLine` (jede Position einmal).
10k2. **Lager-Erweiterung**: Bestand je (Artikel, Lagerort, Charge) nur als Summe des Journals und nie negativ; Seriennummern nur mit Menge ±1 und nie doppelt im Bestand; Verfolgung/Bewertungsverfahren nur ändern, solange es keine Bewegungen gibt; Bewertung nur über `inventory/valuation.ts` (rein, getestet) und nicht speichern; Umbuchungen nie ändern (Gegenumbuchung).
10k3. **Vertrieb**: Lieferung nur gegen bestätigte Aufträge und nie über die offene Menge (Auftrag je Vorgang gesperrt); Versand bucht Lager über `issueStockTx` in derselben Transaktion; Lieferungen nie ändern – Storno per Gegenbuchung, nicht nach Abrechnung; Abrechnung nur über `billOrder` (jede Lieferzeile einmal, Rechnungsentwurf über den Finance-Service).
10k4. **Fertigung**: Stücklisten-Rechnung und Bedarfsplanung nur über `production/bom.ts`/`mrp.ts` (rein, getestet); aktive Stücklisten nie ändern (neue Version), keine Zyklen; Rückmeldung bucht Verbrauch und Zugang in einer Transaktion über die Tx-Funktionen des Lagers (alles oder nichts), Rückmeldungen nie ändern – Rücknahme per Gegenbuchung; MRP bucht nichts.
10k5. **Qualität/Instandhaltung**: Prüfbewertung nur über `quality/rules.ts` (rein, getestet); aktive Prüfpläne nie ändern (neue Version); Prüflose nach dem Entscheid nie ändern, Annahme trotz Mangel nur als Sonderfreigabe mit Begründung; Abweichungen nur mit Ursache und Maßnahme schließen; Fälligkeiten nur über `maintenance/rules.ts`; abgeschlossene Aufträge nie ändern; Ersatzteilverbrauch nur über die Tx-Funktionen des Lagers (alles oder nichts).
10k6. **E-Rechnung/API**: E-Rechnung nur über `finance/einvoice.ts` (rein, getestet; Aussteller nur aus dem Snapshot am Beleg; bei Problemen keine XML); die REST-API ist nur lesend, geht ausschließlich über die Services (Berechtigung und Mandant dort), gibt nur ausdrücklich gemappte Felder aus (nie `organizationId`, interne Konten), Tokens nur als Hash speichern und nie die Berechtigung `api.token.manage` weitergeben; jede neue Route in `_openapi.ts` beschreiben (Test prüft).
10k7. **Konto-Sicherheit**: zweiter Faktor und Reset nur über `platform/auth/*` (reine Teile `totp.ts`, `password.ts`, `secret-box.ts` getestet); Geheimnisse nur verschlüsselt, Codes/Tokens/Wiederherstellungscodes nur als Hash, nie im Audit-Log oder in Protokollen; jeder Code gilt einmal; Antworten auf Reset-Anfragen verraten keine Konten; Passwortwechsel/-reset erhöht `sessionVersion`; Verwaltung fremder Konten nur für Konten, die ausschließlich zur eigenen Organisation gehören.
10l. **Workflows**: nur Benachrichtigungen, keine Datenänderungen; Definitionen nie ändern (neue Version); Ereignisse nur über `platform/events/emit.ts` ohne Personendaten in der Nutzlast; Handler idempotent (dedupeKey, `WorkflowRun` eindeutig).
10m. **Analysen**: Berichte nur über `analytics/service.ts` (Recht auf die Daten zusätzlich zu `analytics.read`); CSV nur über `analytics/csv.ts` (Formelschutz); keine freien Abfragen, keine Personaldaten.
10n. **Installer**: alles, was in Skripte/Dateien einfließt, vorher per Allowlist prüfen (`installer/lib/validate.mjs`); Server-Skript statisch halten (Werte nur über `params`); Passwörter nie in Befehlszeilen oder Protokolle; Archiv ohne `.env`.
10o. **Hauptbuch**: gebucht wird nur über `gl/service.ts` (`writeEntry`: Prüfung, offene Periode, Nummer); Sätze nie ändern (Storno); Belegbuchungen in derselben Transaktion wie die Ausstellung/Freigabe/Zahlung; Buchungsregeln nur in `gl/rules.ts` (rein, getestet).
10p. **Lohnabrechnung**: Berechnung nur über `payroll/calc.ts` (rein, getestet); gesetzliche Werte nie im Code-Pfad, sondern aus `PayrollParamSet`; Freigabe nur mit geprüftem Parametersatz und durch eine andere Person als die erstellende; freigegebene Läufe nie ändern (Storno + neue Version); Gehälter nie ins Audit-Log, Lesezugriffe protokollieren; Mitarbeiter sehen nur die eigene freigegebene Zeile.
11. **UI-Texte** über i18n (`de` Standard, `en`). Nicht implementierte Module klar als „geplant" kennzeichnen.
12. **Keine Behauptung ohne Verifikation**: Features erst als fertig melden, wenn Tests/Typecheck laufen.
13. Demo-Daten nur synthetisch.

## Stil
Kleine, klare Funktionen; keine unnötigen Abhängigkeiten; Tests neben dem Code (`*.test.ts`, Vitest).
