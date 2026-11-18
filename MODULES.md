# Modulplanung: Workforce (Dienstplan, Arbeitszeit, Abrechnung) und weitere Module

Status: **Plan, nichts davon ist umgesetzt.** Grundlage sind die bestehenden Regeln aus [CLAUDE.md](CLAUDE.md) und [ARCHITECTURE.md](ARCHITECTURE.md).
Rechtliche Hinweise sind Arbeitsannahmen für die Planung, **keine Rechtsberatung** – vor der Umsetzung mit Steuerberatung/Jurist und ggf. Betriebsrat klären.

## 1. Ziel und Abgrenzung

Ein zusammenhängender Bereich „Workforce“ auf der bestehenden Plattform (Mandanten, Rollen, Audit, Genehmigungen):

| Modul | Zweck |
|---|---|
| **HR-Basis** (Voraussetzung) | Mitarbeiterverzeichnis, Beschäftigungsverhältnisse, Urlaub/Abwesenheit |
| **Dienstplanung** | Schichten planen, besetzen, veröffentlichen, tauschen |
| **Zeiterfassung** | Ist-Arbeitszeit erfassen, korrigieren, freigeben, Zeitkonten |
| **Abrechnung** | (A) Leistungsabrechnung an Kunden nach Stunden, (B) Lohn-Vorbereitung/Export |

„Arbeitszeitüberwachung“ wird bewusst als **Aufzeichnung und Regelprüfung** geplant (Ruhezeiten, Höchstarbeitszeit, Fehlbuchungen), nicht als Verhaltensüberwachung: kein GPS-Tracking, keine Screenshots, keine Aktivitätsmessung.

### Entscheidung: was heißt „Abrechnung“?
Das Wort deckt zwei verschiedene Dinge ab. Empfehlung:
* **A. Leistungsabrechnung (Kunden):** erfasste Stunden × Satz → Rechnungsposition. Rein fachlich, gut machbar, braucht das Finance-Modul (Rechnungen, Buchungen).
* **B. Lohnabrechnung:** echte Brutto/Netto-Berechnung ist sehr komplex (Kollektivverträge, Sozialversicherung, Lohnsteuer, Sonderzahlungen, Meldungen) und war im Ursprungsauftrag ausdrücklich ausgeschlossen. **Empfehlung: nur Vorbereitung** – geprüfte Stunden, Zuschläge, Abwesenheiten als Export (CSV/Schnittstelle) an die Lohnverrechnung (z. B. BMD, RZL, DATEV). Eigene Lohnberechnung erst als späteres, separates Projekt.

## 2. Abhängigkeiten und Reihenfolge

```
 M6  Plattform-Bausteine (Outbox-Dispatcher, Benachrichtigungen, Genehmigungs-Engine)
  └─ M7  HR-Basis (Mitarbeiter, Beschäftigung, Urlaub/Abwesenheit)
       ├─ M8  Dienstplanung
       └─ M9  Zeiterfassung (nutzt Dienstplan für Soll/Ist, aber auch ohne)
             └─ M10 Abrechnung: B (Lohn-Export) sofort nach M9
                    A (Kundenabrechnung) braucht Projekte (M11) + Finance (M12)
```

Begründung der Reihenfolge:
1. **M6 zuerst**, weil Dienstplan-Veröffentlichung, Tauschanfragen, Urlaubs- und Zeitfreigaben Benachrichtigungen und mehrstufige Freigaben brauchen. Heute werden Outbox-Events geschrieben, aber nicht verarbeitet, und die Freigabeschwelle ist eine Konstante.
2. **M7 vor M8/M9**, weil `Employee` die Grundlage für alles ist (Schema teilweise vorbereitet, Funktion fehlt).
3. **Zeiterfassung vor Dienstplan-Feinheiten** wäre möglich, wenn der Kunde zuerst Stunden braucht. Der Dienstplan liefert aber die Sollzeiten für Plan/Ist-Vergleich – deshalb M8 vor M9, außer die Priorität liegt auf Abrechnung.

## 3. Modul HR-Basis (M7)

**Funktionen:** Mitarbeiterverzeichnis, Abteilungszuordnung (vorhanden), Beschäftigungsverhältnis (Eintritt/Austritt, Wochenstunden, Vertragsart), Abwesenheitsarten (Urlaub, Krankenstand, Pflegefreistellung …), Urlaubsanspruch/-saldo, Urlaubsanträge mit Freigabe.

**Datenmodell (neu):** `Employee` (Verknüpfung optional zu `User`), `EmployeeSensitive` (getrennt, eigene Permission), `Employment` (Zeiträume, Sollstunden/Woche, Kostenstelle), `AbsenceType`, `AbsenceRequest`, `LeaveBalanceEntry` (Journal: Anspruch, Verbrauch, Übertrag – append-only).

**Regeln:** Sensible Felder nur mit `hr.employee.read_sensitive`; Krankheitsgründe werden **nicht** gespeichert (nur „krank“); Salden sind ein Journal, kein überschreibbares Feld.

## 4. Modul Dienstplanung (M8)

**Funktionen**
* Standorte/Bereiche, Positionen und Qualifikationen (z. B. „Kasse“, „Ersthelfer“)
* Schichtvorlagen und Wiederholungsmuster; Bedarfsvorgabe je Zeitraum („mind. 2 Personen Früh“)
* Planung im Wochen-/Monatsraster mit Drag-and-drop (Tastatur-bedienbar), Besetzung offener Schichten
* Verfügbarkeiten und Wünsche der Mitarbeiter; Abwesenheiten aus M7 sperren automatisch
* **Regelprüfung beim Planen** (Warnung oder Sperre je Regel): tägliche Ruhezeit, Höchstarbeitszeit pro Tag/Woche, wöchentliche Ruhezeit, Mindestbesetzung, fehlende Qualifikation, Doppelbelegung
* Veröffentlichen mit **Versionen**: veröffentlichte Pläne sind unveränderlich, Änderungen erzeugen eine neue Version mit Änderungsprotokoll und Benachrichtigung der Betroffenen
* Schichttausch/-übernahme: Mitarbeiter fragt an, Kollegin stimmt zu, Führungskraft gibt frei (nutzt Genehmigungs-Engine)
* Ansicht „Mein Dienstplan“, Export (iCal, PDF)

**Datenmodell (neu):** `Site`, `Position`, `Qualification`, `EmployeeQualification`, `ShiftTemplate`, `StaffingRequirement`, `Roster` (Plan je Zeitraum, Status, Version), `Shift`, `ShiftAssignment`, `AvailabilityRule`, `ShiftSwapRequest`.

**Permissions (Beispiele):** `roster.read`, `roster.read_all`, `roster.plan`, `roster.publish`, `roster.swap.request`, `roster.swap.approve`, `roster.rules.manage`.

**Wichtige Designentscheidungen**
* Regelprüfung als **reine, getestete Funktionen** (Eingabe: Schichten + Regelsatz, Ausgabe: Verstöße). Regelsatz konfigurierbar je Organisation, mit Voreinstellung „Österreich, Arbeitszeitgesetz“ und überschreibbar durch Kollektivvertrag/Betriebsvereinbarung.
* Zeiten werden in **UTC + Zeitzone des Standorts** gespeichert; Sommerzeitumstellung (23-/25-Stunden-Tage) und Nachtschichten über Mitternacht sind eigene Testfälle.
* Planung nur in der Organisation des Benutzers (Tenant-Regeln unverändert).

**Spätere Ausbaustufe:** automatische Schichtvorschläge (Optimierung). Zunächst bewusst nicht enthalten; die Regelprüfung ist die Grundlage dafür.

## 5. Modul Zeiterfassung und Arbeitszeitüberwachung (M9)

**Funktionen**
* Kommen/Gehen/Pause per Web (später Smartphone-Web-App/Terminal); Buchung auf Kostenstelle, Projekt oder Aufgabe
* Nachträgliche und manuelle Erfassung mit Begründung und Freigabe
* **Korrekturen nur als dokumentierte Gegenbuchung** (wie im Finanzbereich): Originaleintrag bleibt, Korrektur verweist darauf, mit Wer/Wann/Warum
* Plan/Ist-Vergleich gegen den Dienstplan, Abweichungsliste
* Zeitkonten (Gleitzeit-, Überstunden-, Zeitausgleichskonto) als **Journal**; Zuschläge (Nacht, Sonn-/Feiertag, Überstunde) über Regeltabellen
* Periodenabschluss: Monat wird von der Führungskraft freigegeben und **gesperrt**; spätere Änderung nur über Entsperr-Vorgang mit Audit
* Compliance-Hinweise für Mitarbeiter und Führungskräfte: fehlende Buchung, Überschreitung Höchstarbeitszeit, unterschrittene Ruhezeit, nicht genommene Pause
* Eigene Einsicht für Mitarbeiter in ihre Daten (Auskunftsrecht)

**Datenmodell (neu):** `TimeEntry` (append-only), `TimeEntryAdjustment`, `TimesheetPeriod` (Status offen/eingereicht/freigegeben/gesperrt), `TimeAccountEntry` (Journal), `PayCodeRule` (Zuschläge), `PublicHoliday`/`CalendarRegion`.

**Permissions:** `time.entry.own`, `time.entry.read_all`, `time.entry.correct`, `time.period.approve`, `time.period.reopen`, `time.rules.manage`, `time.report.read`.

### Datenschutz und Arbeitsrecht (vor Umsetzung klären)
* Zeitaufzeichnung für Arbeitnehmer ist in Österreich grundsätzlich Pflicht des Arbeitgebers; **Kontrollmaßnahmen** (Einführung eines Zeiterfassungssystems) können eine **Betriebsvereinbarung bzw. Zustimmung des Betriebsrats** erfordern. Das gehört in die Einführungs-Checkliste, nicht in den Code.
* DSGVO: Zweckbindung, Datenminimierung, Aufbewahrungs- und Löschfristen festlegen, Verzeichnis von Verarbeitungstätigkeiten, ggf. Datenschutz-Folgenabschätzung. Keine Standortdaten, keine verdeckte Überwachung.
* Zugriff: Mitarbeiter sehen ihre eigenen Daten; Führungskräfte nur ihres Teams; Auswertungen standardmäßig auf aggregierter Ebene.
* **Nicht** Teil des Systems: Leistungsbewertung einzelner Personen aus Zeitdaten.

## 6. Modul Abrechnung (M10)

### B. Lohn-Vorbereitung und Export (zuerst)
* Aus freigegebenen, gesperrten Zeitperioden: Normalstunden, Mehr-/Überstunden, Zuschläge, Abwesenheiten je Mitarbeiter und Periode
* Export als CSV (konfigurierbares Format je Zielsystem), Prüfprotokoll, **Export-Läufe sind unveränderlich**; Korrekturen nach Export erzeugen einen Nachtrag
* Plausibilitätsprüfung vor Export (offene Perioden, ungeklärte Abweichungen)
* **Keine** Berechnung von Brutto/Netto, Steuern oder Sozialversicherung

### A. Leistungsabrechnung (Kunden)
* Abrechenbare Zeiten aus Zeiterfassung (Projekt/Kunde) × Stundensatz (je Person, Rolle oder Projekt, mit Gültigkeitszeitraum und Währung)
* Abrechnungslauf: Entwurf → Prüfung → Freigabe → Rechnungsposition. Gebuchte Zeiten tragen einen Verweis auf die Rechnung und sind danach gesperrt
* Pauschalen, Budgets und Obergrenzen je Projekt; Hinweis bei Überschreitung
* **Benötigt Projekte (M11) und Finance (M12)**: Rechnung, Steuerkennzeichen, Buchung nach Doppik. Bis dahin nur Export der abrechenbaren Positionen.

**Datenmodell (neu):** `PayrollExport`, `PayrollExportLine`, `BillingRate`, `BillingRun`, `BillingLine` (Verweis auf `TimeEntry` und später `Invoice`).

**Finanzregeln:** Geld nur `Decimal`, Stunden als Dezimalstunden oder Minuten (ganzzahlig, **nicht** Gleitkomma), Rundungsregeln explizit konfigurierbar (z. B. auf 5/6 Minuten) und getestet.

## 7. Weitere Module (Backlog, ohne Detailplanung)

| Modul | Kern | Abhängigkeit |
|---|---|---|
| **Projekte (M11)** | Projekte, Aufgaben, Meilensteine, Budgets, Zeitbuchung | Kostenstellen, M9 |
| **Finance (M12)** | Kontenplan, Journal (Doppik, Storno), Debitoren/Kreditoren, Rechnungen, Zahlungen, Steuern | – |
| **Wareneingang und Rechnungsabgleich** | Beschaffung bis Zahlung schließen | Finance |
| **Inventar** | Artikel, Lager, Bewegungen (append-only), Bestände | Beschaffung |
| **CRM** | Firmen, Kontakte, Leads, Pipeline | Projekte (für A) |
| **Workflow-Designer** | Versionierte Definitionen statt Konstanten | M6 |
| **Analysen** | Auswertungen über Module | Daten der Module |
| **REST-API mit OpenAPI** | war im Ursprungsauftrag gefordert, fehlt bisher | Services stabil |
| **Plattform-Härtung** | MFA, Postgres Row-Level-Security, verteiltes Rate-Limit, Dependency-/Secret-Scan, i18n vollständig | – |

## 8. Meilensteine mit Abnahmekriterien

| # | Inhalt | Fertig, wenn … |
|---|---|---|
| M6 | Outbox-Dispatcher, Benachrichtigungen, Genehmigungs-Engine (mehrstufig, konfigurierbar) | Beschaffungsfreigabe läuft über die Engine; Benachrichtigung bei Freigabebedarf; Wiederholung bei Fehlern getestet |
| M7 | HR-Basis | Mitarbeiter/Urlaub funktionsfähig; sensible Daten nur mit Sonderrecht (Test); Saldo = Summe des Journals |
| M8 | Dienstplanung | Plan erstellen, Regelverstöße erkennen, veröffentlichen mit Version, Tausch freigeben; DST- und Nachtschicht-Tests grün |
| M9 | Zeiterfassung | Buchen, korrigieren per Gegenbuchung, Periode sperren; Plan/Ist; Zeitkonto-Journal stimmt; kein Löschen/Ändern gesperrter Daten (Test) |
| M10 | Lohn-Export (B), danach Kundenabrechnung (A) | Export reproduzierbar und unveränderlich; Rundungs- und Summentests; Abrechnung verweist auf Zeiten |

Je Meilenstein wie bisher: Migration + Seed (synthetisch), Services mit `authorize()`, Audit + Outbox in derselben Transaktion, Mandanten- und Autorisierungstests, E2E-Szenario, axe-Prüfung, Doku-Update.

## 9. Teststrategie (Besonderheiten)
* **Regel-Engine:** tabellengetriebene Unit-Tests mit Grenzfällen (genau 11 h Ruhe, 12 h/Tag, 60 h/Woche, Mitternacht, Zeitumstellung März/Oktober, Schaltjahr).
* **Journale:** Eigenschaftstests: Saldo ist unabhängig von der Reihenfolge der Buchungen; Korrektur + Original = Netto-Wirkung.
* **Parallelität:** gleichzeitiges Besetzen derselben Schicht, gleichzeitiges Freigeben/Entsperren einer Periode.
* **Datenschutz:** Mitarbeiter A sieht nie Zeitdaten von B; Führungskraft nur ihr Team; Export enthält keine Felder ohne Berechtigung.

## 10. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Rechtlich: Arbeitszeitrecht, Kollektivverträge, Betriebsrat, DSGVO | Regelsatz konfigurierbar statt hartcodiert; Einführungs-Checkliste; Rechtsprüfung vor Produktivbetrieb |
| „Abrechnung“ wird als vollständige Lohnverrechnung erwartet | Frühe Klärung (Abschnitt 1); nur Export zusagen |
| Zeitzonen/Sommerzeit-Fehler | UTC-Speicherung, Standort-Zeitzone, eigene Tests |
| Nachträgliche Manipulation von Zeiten | Append-only, Gegenbuchungen, Periodensperre, Audit |
| Umfang der Dienstplan-Oberfläche (Drag-and-drop, Barrierefreiheit) | Erst Listen-/Rasteransicht mit Tastaturbedienung, Drag-and-drop später |
| Mobile Nutzung (Stempeln unterwegs) | Zuerst responsive Web; Offline-Fähigkeit/native App nur bei Bedarf |

## 11. Offene Fragen (mit Empfehlung)

1. **Land/Rechtsrahmen?** Empfehlung: Österreich (AZG/ARG) als Voreinstellung, Regelsatz austauschbar.
2. **Welche Branche/Kollektivverträge?** Bestimmt Zuschläge und Ruhezeitregeln. Empfehlung: mit einem konkreten Pilotbetrieb beginnen.
3. **Lohn: Export oder Berechnung?** Empfehlung: Export; Zielsystem benennen.
4. **Wer stempelt womit?** Web, Smartphone, Terminal/Badge? Empfehlung: responsive Web zuerst.
5. **Gibt es einen Betriebsrat?** Beeinflusst Einführung und Auswertungsrechte.
6. **Reihenfolge:** Dienstplan zuerst oder Zeiterfassung/Abrechnung zuerst? Empfehlung wie in Abschnitt 2; bei Priorität „Stunden abrechnen“ M9 vorziehen.
7. **Kundenabrechnung (A) jetzt oder nach Finance?** Empfehlung: nach Finance; bis dahin Export der abrechenbaren Positionen.
