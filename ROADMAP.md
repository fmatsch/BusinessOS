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
* ✅ Unit-Tests (Regeln, Validierung, Rate-Limit, Autorisierung, KI-Schleife)
* ✅ Integrationstests gegen echte PostgreSQL (Beschaffungsfluss, Parallelität, Rollback)
* ✅ Tenant-Isolation (Stammdaten, Beschaffung, Budget, KI-Werkzeuge, Browser)
* ✅ Autorisierungsmatrix: jede Service-Operation verweigert ohne Permission; Rollen-Zuschnitt festgeschrieben
* ✅ Finanzkonsistenz: Dezimalarithmetik, Summen, Storno, Geschäftsjahresgrenzen, lückenlose Belegnummern bei Parallelität, ungültige Beträge, Rollback
* ✅ Architekturtests: Modulgrenzen, kein Server-Code im Client-Bundle, keine Geheimnisse in `NEXT_PUBLIC_`, keine Float-Geldberechnung
* ✅ E2E im Browser (Playwright): kompletter Prozess über vier Rollen, Mandantentrennung, Zugriffsschutz, Login-Fehler, Sicherheits-Header
* ✅ Barrierefreiheit: axe-core (WCAG 2.0/2.1 A/AA) auf allen Seiten in Hell und Dunkel, Tastaturfokus
* ✅ Gefunden und behoben: Dark-Mode-CSS war ungültig, Kontrast Button/Fehlertext im Dunkelmodus, CSP-Header fehlte trotz Dokumentation
* ⚠️ Automatische A11y-Prüfung deckt nur einen Teil ab; kein Screenreader-/manueller Test
* ⚠️ Keine Lasttests, keine Penetrationstests, kein Dependency-/Secret-Scanning in CI
* ⚠️ CSP erlaubt `'unsafe-inline'` für Skripte (Next.js ohne Nonce)

## M6 – Plattform-Bausteine (Voraussetzung für Workforce)
* ✅ Outbox-Dispatcher: `FOR UPDATE SKIP LOCKED` (kein Doppelverarbeiten bei parallelen Prozessen), Handler laufen in der Transaktion mit Savepoint (Fehler rollt nur den Handler zurück), exponentielles Backoff, Dead Letter nach 5 Versuchen
* ✅ Auslösung: unmittelbar nach Beschaffungs-Aktionen (`after()`), dazu `npm run worker` als Hintergrundprozess, der Versäumtes nachholt
* ✅ Benachrichtigungen: idempotent (`dedupeKey`), Glocke mit Ungelesen-Zähler, Seite `/notifications`; Beschaffung benachrichtigt Freigeber, Antragsteller und Einkauf
* ✅ Genehmigungs-Engine: Freigabeschritte kommen aus einer **versionierten Regel** je Organisation (`/settings/approvals`); laufende Vorgänge behalten Schritte und Berechtigung (Schnappschuss), neue Regel gilt nur für neue Vorgänge
* ✅ Beschaffung nutzt die Engine statt fester Konstanten (Altdaten per Migration übernommen)
* ⚠️ Kein Überwachungs-/Alarmierungskanal für Dead Letters (nur Spalten `failedAt`/`lastError`); keine E-Mail-/Push-Zustellung (nur In-App)
* ⚠️ Regeleditor begrenzt: max. 3 Schritte in der Oberfläche, nur Beschaffungs-Berechtigungen, Bedingung nur „Betrag über X"
* ⚠️ Gleichzeitiges Veröffentlichen zweier Regelversionen endet für eine Seite in einem Fehler (eindeutige Version)

## M7 – HR-Basis
* ✅ Mitarbeiterverzeichnis (Personalnummer je Organisation eindeutig, Abteilung, Führungskraft ohne Zyklen, Verknüpfung zum Benutzerkonto), Seiten `/hr`, `/hr/[id]`
* ✅ Beschäftigungsverhältnisse (Zeiträume ohne Überschneidung, Wochenstunden, Vertragsart, Kostenstelle) – nur Personal und die Person selbst
* ✅ Persönliche Angaben getrennt gespeichert, eigene Berechtigung; **jeder Lesezugriff wird im Audit-Log protokolliert**, Inhalte stehen nie im Audit-Log
* ✅ Urlaubskonto als **Journal** (Anspruch, Übertrag, Korrektur, Verbrauch, Storno), per DB-Trigger append-only; Saldo = Summe, Korrektur nur per Gegenbuchung
* ✅ Abwesenheiten: Urlaub/Pflegefreistellung/Sonderurlaub mit Freigabe über die Genehmigungs-Engine (nur direkte Führungskraft oder Personal, keine Selbstfreigabe), Krankenstand ohne Freigabe (keine Diagnosen); Arbeitstage nach österreichischem Feiertagskalender, Jahreswechsel wird je Jahr gebucht
* ✅ Sperre je Mitarbeiter (Zeilensperre) gegen Überbuchung bei parallelen Anträgen/Freigaben; Benachrichtigungen an Führungskraft/Personal/Antragsteller
* ⚠️ Annahmen: 5-Tage-Woche Mo–Fr, nur österreichische gesetzliche Feiertage (kein Länderprofil, keine Teilzeit-Arbeitstage, keine halben Tage) – folgt mit der Zeiterfassung
* ⚠️ Kein Resturlaubs-Verfall/Übertragsautomatik, keine Abwesenheitsarten-Verwaltung in der Oberfläche, keine Freigaberegel-Oberfläche für Abwesenheiten (Standard: Führungskraft)
* ⚠️ Mitarbeiter ohne verknüpftes Benutzerkonto können keine Anträge stellen; Löschung/Anonymisierung (DSGVO) noch nicht umgesetzt
* ⚠️ Login-Sperre nach 5 Fehlversuchen kann auch Dritte aussperren (Konto-DoS); dafür MFA/IP-Drosselung nötig
* ✅ Behoben: Login-Limit zählte auch erfolgreiche Anmeldungen; Benachrichtigungs-Link verletzte „Label in Name" (WCAG 2.5.3)

## M8 – Dienstplanung
* ✅ Standorte (mit Zeitzone), Qualifikationen, Schichtvorlagen, Pläne je Standort (≤ 42 Tage, keine Überschneidung), Schichten mit Besetzungsbedarf, Zuweisung
* ✅ Regelprüfung (reine, getestete Funktionen; je Organisation einstellbar): Tagesruhe, Höchstarbeitszeit je Tag/Woche, Pause, Doppelbuchung, Abwesenheit, Beschäftigung, Qualifikation → **Fehler blockieren** Zuweisung und Veröffentlichung, Unterbesetzung und fehlende Wochenruhe sind **Hinweise**
* ✅ Ortszeit je Standort, Speicherung in UTC; Zeitumstellung getestet (nicht existierende Uhrzeit wird abgelehnt, Nachtschicht = 7 h bzw. 9 h)
* ✅ Veröffentlichen mit **Versionen**: unveränderlicher Snapshot (DB-Trigger) mit Änderungsprotokoll; Mitarbeiter sehen erst die veröffentlichte Version; Benachrichtigung der Betroffenen (neu/entfernt)
* ✅ „Mein Dienstplan" und iCal-Export (`/roster/my.ics`, nur eigene Schichten)
* ✅ Schichttausch: Anfrage → Zustimmung der Kollegin/des Kollegen (mit Regelprüfung) → Freigabe durch Planung oder direkte Führungskraft → automatisch neue Version
* ✅ Sperren gegen Rennen: gleichzeitiges Zuweisen derselben Person, Veröffentlichen, Tausch-Entscheidungen
* ⚠️ Nicht umgesetzt: Verfügbarkeiten/Wünsche, Wiederholungsmuster, automatische Schichtvorschläge, PDF-Export, Drag-and-drop (Listenansicht mit Formularen)
* ⚠️ Regelvereinfachungen: Arbeitszeit wird dem Tag/der Woche des Schichtbeginns zugerechnet; Wochenruhe als längste Pause im Wochenfenster (nur Hinweis); Kollektivverträge nur über einstellbare Grenzwerte
* ⚠️ Eine nach der Veröffentlichung genehmigte Abwesenheit wird erst bei der nächsten Veröffentlichung als Konflikt gemeldet (keine automatische Warnung am Plan)
* ⚠️ Tausch nur freigebbar, wenn der Plan keine unveröffentlichten Änderungen hat; Tausch läuft nicht über die Genehmigungs-Engine
* ⚠️ Zeiten in der Übersicht werden in der Organisationszeitzone angezeigt (Schichten anderer Zeitzonen eines Standorts werden dort nicht umgerechnet beschriftet)

## M9 – Zeiterfassung
* ✅ Stempeluhr (Kommen, Pause, Gehen) im Web; vergessenes Ausstempeln (> 16 h) wird nicht gebucht, sondern verworfen und per Antrag nachgetragen
* ✅ **Buchungsjournal append-only** (DB-Trigger): Korrektur = Gegenbuchung + neue Buchung, Original bleibt sichtbar; Nachträge/Korrekturen/Stornos werden **beantragt und von der direkten Führungskraft oder dem Personalwesen freigegeben** (nie selbst); Personalwesen kann mit Begründung direkt buchen
* ✅ Monatsabschluss: einreichen (sperrt Eigenaktionen) → freigeben (sperrt für alle, bucht Ist − Soll ins **Zeitkonto-Journal**) oder zurückgeben; Wiederöffnen nur Personalwesen mit Begründung (Gegenbuchung im Zeitkonto)
* ✅ Auswertung: Ist, Soll (Wochenstunden/5 an Arbeitstagen, Abwesenheiten neutral), Kategorien Nacht/Sonntag/Feiertag/Mehrzeit in Minuten, **Plan/Ist** je Tag gegen den veröffentlichten Dienstplan, **Compliance-Hinweise** (Pause, Ruhezeit, Höchstarbeitszeit – dieselben einstellbaren Regeln wie der Dienstplan)
* ✅ Datenschutz: eigene Daten; Führungskraft nur direktes Team; Personalwesen alle; **jeder Fremdzugriff wird im Audit-Log protokolliert**; keine Ortung, keine Aktivitätsmessung
* ✅ Sperren gegen Rennen: paralleles Einstempeln, Freigeben, Buchen je Person
* ⚠️ Annahmen: 5-Tage-Woche, österreichischer Feiertagskalender, Buchung wird dem Monat des Beginns zugeordnet, Zuschlagskategorien anteilig nach Pausenabzug; keine halben Tage/Teilzeit-Arbeitstage, keine Gleitzeit-Kernzeiten
* ⚠️ Zuschlagsprozente (`PayCodeRule`) sind hinterlegt, werden aber erst vom Lohn-Export (M10) verwendet; „Mehrzeit" = positiver Monatssaldo (kein Überstundenmodell nach Kollektivvertrag)
* ⚠️ Nur Web (kein Terminal/Smartphone-Offline); Buchungen in der Zukunft nicht möglich; Mindestdauer einer Stempelung 1 Minute
* ⚠️ Kein Löschkonzept/Aufbewahrungsfristen für Zeitdaten; Einführung kann Betriebsvereinbarung/Betriebsratszustimmung erfordern (siehe MODULES.md)
* ⚠️ Beschäftigungsdaten sind Voraussetzung für die Freigabe eines Monats (sonst gäbe es kein Soll)

## M10 – Lohn-Export (Vorbereitung für die Lohnverrechnung)
* ✅ Exportzeilen aus **freigegebenen Monaten**: Normalarbeitszeit, Mehrzeit über Soll, Zuschlagsbasen Nacht/Sonntag/Feiertag (mit Prozent aus der Zuschlagsregel), Urlaub/Krankenstand/Pflegefreistellung/Sonderurlaub in Arbeitstagen
* ✅ Zeilenbasierte CSV mit **konfigurierbarem Profil** (Trennzeichen, Dezimalzeichen, Zeichensatz, Stunden/Minuten, Kopfzeile) und **Lohnart-Zuordnung** je Organisation; ohne Zuordnung kein Export
* ✅ Plausibilitätsprüfung vor dem Export (nicht freigegebene Monate, fehlende Lohnarten, Beschäftigte ohne Zeit und ohne Abwesenheit, Plan/Ist-Lücken); Unvollständige nur nach ausdrücklicher Bestätigung
* ✅ **Exportläufe unveränderlich** (DB-Trigger) mit Prüfsumme (SHA-256 der Ausgabebytes, beim Download geprüft); Änderungen nach dem Export erscheinen im nächsten Lauf als **Nachtrag mit Differenzen (auch negativ)**; Summe aller Läufe = aktueller Stand (Test)
* ✅ Parallele Läufe je Monat serialisiert (Advisory Lock); Export und Abruf im Audit-Log; Lesen auch für Finanzen, Erzeugen/Profil nur Personalwesen/Inhaber
* ⚠️ **Kein vorgefertigtes Format** für BMD, RZL, DATEV o. Ä.: die Datei muss in deren Importassistent zugeordnet werden – ob das Ihr Programm abdeckt, ist mit dem Lohnverrechner zu klären
* ⚠️ Keine Lohnberechnung (Brutto/Netto, Steuern, Sozialversicherung, Sonderzahlungen, Meldungen); Zuschlagsprozente sind Konfiguration, kein Rechtsrat; Zuschlagsbasen sind Teilmengen der Arbeitszeit
* ⚠️ Abwesenheiten: nur die vier Standardarten werden exportiert; Zeitkonto-Auszahlungen (Überstunden auszahlen) sind noch nicht abgebildet; Exporte nur für abgeschlossene Monate
* ⚠️ Keine direkte Schnittstelle (Upload/API); die Datei wird heruntergeladen. Keine Aufbewahrungs-/Löschregeln für Exportläufe

## M12 Finance – Belegerfassung und Export an die Steuerberatung (Variante B)
Entscheidung: kein eigenes Hauptbuch; die Steuerberatung bucht. Detailplan: [FINANCE.md](FINANCE.md).

* ✅ Kontenliste (Import alles-oder-nichts), Steuerkennzeichen mit Zuordnung auf BMD-Steuercode bzw. DATEV-BU-Schlüssel, Kreditoren-/Debitorenkonten, Buchhaltungsprofil
* ✅ Eingangsrechnungen mit Belegupload (PDF/PNG/JPEG per Inhaltsprüfung, max. 8 MB), Dublettenprüfung, **Vier-Augen-Freigabe**, fortlaufende Belegnummer `ER-JJJJ-NNNN`
* ✅ Ausgangsrechnungen (Entwurf, Ausstellen mit lückenloser Nummer `AR-JJJJ-NNNN`, Gutschrift, bezahlt)
* ✅ Steueraufteilung je Steuersatz (Rundung mit Restverteilung) – rein und getestet
* ✅ Export **BMD (BuErf variabel, CSV)** und **DATEV (Buchungsstapel, EXTF 700/Format 13, Windows-1252)** inkl. Belegpaket (ZIP); jeder Beleg genau einmal; Exportläufe unveränderlich mit Prüfsumme; Vorabprüfung; Download im Audit-Log
* ⚠️ **Beide Formate wurden nicht gegen echte BMD-/DATEV-Systeme getestet**, sondern nach den veröffentlichten Beschreibungen gebaut – vor Produktivbetrieb mit der Steuerberatung prüfen (u. a. Annahme zu Buchcode/Buchsymbol)
* ⚠️ Kein PDF für ausgestellte Ausgangsrechnungen · keine Fremdwährung · keine Bankanbindung · keine Verknüpfung Rechnung ↔ Budget

## Danach
Detailplan für Workforce (HR-Basis, Dienstplanung, Zeiterfassung, Abrechnung) und weitere Module: [MODULES.md](MODULES.md). Entschieden: Abrechnung = zuerst Lohn-Export.

* ⬜ Kundenabrechnung nach Stunden (braucht Projekte und Finance)
* ⬜ M13 Wareneingang und Rechnungsabgleich – Plan: [PROCUREMENT-NEXT.md](PROCUREMENT-NEXT.md) · M11 Projekte · Wareneingang/Rechnungsabgleich · Inventar · CRM · Workflow-Designer · Analysen
* ⬜ REST-API mit OpenAPI (im Ursprungsauftrag gefordert, noch nicht umgesetzt) · MFA · Row-Level-Security
