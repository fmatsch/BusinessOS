# Planung Finance (M12): Buchhaltung, Eingangs- und Ausgangsrechnungen, Zahlungen

Status: **Plan (Variante B gewählt, siehe Abschnitt 0), nichts davon ist umgesetzt.** Es gibt bisher weder Konten noch Buchungen, Rechnungen oder Zahlungen im Schema (die frühere Angabe „vorbereitet" in `DATABASE.md` war ungenau und ist korrigiert). Vorhanden sind nur Kostenstellen, Lieferanten, Bestellungen und Budgets.

Rechtliche und steuerliche Aussagen sind **Arbeitsannahmen für Österreich** und müssen vor der Umsetzung mit einer Steuerberatung geprüft werden. Keine Rechts- oder Steuerberatung.

## 0. Entscheidung (2026-11-19): Die Steuerberatung bucht – wir liefern Belege und Buchungsstapel

Das Unternehmen führt **keine eigene Finanzbuchhaltung**; die Steuerberatung bucht extern. Damit gilt **Variante B** und der Umfang schrumpft deutlich gegenüber der vollen Buchhaltung (Variante A, unten weiter dokumentiert, aber **nicht** geplant):

| | Variante A (verworfen) | **Variante B (gewählt)** |
|---|---|---|
| Hauptbuch (Journal, Salden, Periodenabschluss) | ja | **nein** – die Steuerberatung führt die Bücher |
| GuV, Bilanz, UVA-Vorschau | ja | **nein** (Verantwortung bleibt bei der Steuerberatung) |
| Eingangs- und Ausgangsrechnungen | ja | **ja** (Belegerfassung mit Kontierungsvorschlag) |
| Zahlungsstatus / Offene Posten | ja | **ja** (operativ, nicht als Buchung) |
| Belegarchiv (Rechnungsdatei) | optional | **ja**, weil die Steuerberatung Belege braucht |
| Export | ein Baustein | **der Kern**: Buchungsstapel + Belege, unveränderliche Läufe mit Nachträgen |
| Bankabgleich | ja | optional, später |

**Neue Meilensteine (ersetzen die Tabelle in Abschnitt 7 für die Umsetzung):**

| # | Inhalt | Abnahme |
|---|---|---|
| E1 | **Stammdaten für den Export**: Kontenplan-Import (Liste der Konten, die die Steuerberatung nennt), Steuerkennzeichen mit Zuordnung zu deren Schlüsseln, Personenkonten (Kreditoren/Debitoren-Nummern), Kontierungsvorschläge je Lieferant/Kostenstelle | Import ohne Verlust; ungültige Konten/Steuerschlüssel werden abgewiesen; Mandantentrennung |
| E2 | **Eingangsrechnungen**: Erfassung, Beleg-Upload (Dateiprüfung), Bestellabgleich, Freigabe über die Genehmigungs-Engine, Kontierung, Zahlungsstatus, Budget „fakturiert/bezahlt" | Brutto = Netto + Steuer exakt; Lieferanten-Rechnungsnummer eindeutig; Doppelerfassung erkannt; Beleg unveränderlich nach Freigabe |
| E3 | **Ausgangsrechnungen**: Kunden (minimal), Rechnungen mit lückenloser Nummer, PDF, Gutschrift/Storno als Gegenbeleg | Nummernkreis lückenlos bei Parallelität; ausgestellte Rechnung unveränderlich |
| E4 | **Export an die Steuerberatung**: Profil (Format, Konten-/Steuer-Zuordnung), Buchungsstapel + Belegpaket (ZIP), Prüfungen vor dem Export, **unveränderliche Läufe mit Prüfsumme und Nachtrag als Differenz** (wie beim Lohn-Export) | Summe aller Läufe = aktueller Belegstand; bereits exportierte Belege nie stillschweigend geändert; Download im Audit-Log |
| E5 | Optional: Bank-Import und Zahlungsabgleich | wie F4 |
| E6 | Kundenabrechnung nach Stunden (mit Projekten M11) | wie F6 |

**Wiederverwendung:** Das Muster aus M10 (Profil, Plausibilitätsprüfung, unveränderliche Läufe, Differenz-Nachtrag, Prüfsumme) wird für E4 übernommen. Neu sind Dateiablage und -prüfung (Upload) als Plattformbaustein.

**Was jetzt zuerst geklärt werden muss (blockiert E1/E4):**
1. **Welche Software nutzt die Steuerberatung** (BMD, RZL, DATEV oder andere) und **welchen Import** erwartet sie? Bitte ein Importformat-Merkblatt oder eine Beispieldatei von der Steuerberatung besorgen. Ich erfinde kein Format und behaupte keine Kompatibilität ohne diese Vorlage; bis dahin bleibt der Export ein konfigurierbares zeilenbasiertes Profil wie beim Lohn-Export.
2. **Soll- oder Istversteuerung** und welche Steuerfälle (Reverse Charge, innergemeinschaftlich) – bestimmt die Steuerschlüssel im Export.
3. **Belege:** Will die Steuerberatung die Belegbilder (PDF) im Paket oder nur die Buchungsliste?
4. **Kontierung:** Kontiert die Steuerberatung selbst (wir liefern nur Beleg + Betrag + Steuer) oder soll ein Kontierungsvorschlag mitgeliefert werden?

Die Abschnitte 1–10 darunter beschreiben weiterhin die **volle Buchhaltung (Variante A)** als Referenz für den Fall, dass das Unternehmen später doch selbst bucht.

## 1. Ziel und Abgrenzung

Eine nachvollziehbare **doppelte Buchführung** als gemeinsame Quelle der Wahrheit für Geld, an die Beschaffung (Bestellung → Eingangsrechnung → Zahlung), Budgets, den Lohn-Export und später Kundenabrechnung angeschlossen werden.

**Im Umfang:** Kontenplan, Geschäftsjahre und Perioden, Journal mit Storno, Steuerkennzeichen und Umsatzsteuer-Berechnung, Eingangsrechnungen mit Abgleich, Ausgangsrechnungen, Offene Posten, Zahlungen und Bankabgleich, Auswertungen (Saldenliste, GuV, Bilanz, UVA-Vorschau), Export an die Steuerberatung.

**Nicht im Umfang (zunächst):** Anlagenbuchhaltung (AfA), Kostenrechnung über Kostenstellen hinaus, Konsolidierung mehrerer Gesellschaften, direkte Übermittlung an FinanzOnline, Registrierkasse, Lohnverrechnung (bleibt Export), Mahnwesen mit Verzugszinsen (später).

## 2. Entscheidungen, die vor dem Start getroffen werden müssen

| # | Frage | Empfehlung | Warum |
|---|---|---|---|
| 1 | Bilanzierung (Doppik) oder Einnahmen-Ausgaben-Rechnung? | **Doppik als Kern**; EAR als spätere Sicht auf dieselben Buchungen | Ein Kern, der beides kann; Ursprungsauftrag fordert Doppik |
| 2 | Kontenrahmen | Österreichischer Einheitskontenrahmen als **austauschbare Vorlage** (importierbar), Konten pro Organisation anpassbar | Steuerberatungen arbeiten mit Kontenrahmen; kein Zwang zu einem festen |
| 3 | Soll- oder Istversteuerung | Beides als Organisationseinstellung; **Sollversteuerung zuerst** | Istversteuerung braucht zusätzliche Steuerkonten und Zahlungszuordnung |
| 4 | Währungen | Buchung in Organisationswährung; Fremdwährungsbelege mit Kurs je Beleg, **keine automatische Neubewertung** zunächst | Hält den Kern einfach; Kursdifferenzen als eigene Buchung |
| 5 | Wer führt die Bücher? | Steuerberatung bucht extern (nur Export) **oder** Unternehmen bucht selbst | Bestimmt, ob Berichte/UVA nötig sind oder ein sauberer Export genügt |
| 6 | E-Rechnung | Struktur (XML) als Ausbaustufe nach F3, erst nach Klärung der geltenden Pflichten | Rechtslage ändert sich; nicht raten |
| 7 | Zielsystem der Steuerberatung | BMD / RZL / DATEV / anderes, jeweils **Export über Zuordnungsprofil** wie beim Lohn-Export | Kein Format erfinden, das niemand importiert |

## 3. Kernprinzipien (aus bestehenden Regeln)

* Geld nur `Decimal`, Währungscode je Betrag; Rundung explizit und getestet (Steuer je Beleg, nicht je Zeile, wo vorgeschrieben – prüfen).
* **Gebuchte Daten werden nie geändert oder gelöscht.** Korrektur = Storno-Buchung (Gegenbuchung) plus neue Buchung, wie bei Zeitbuchungen. Datenbank-Trigger erzwingen das (wie `TimeEntry`).
* Jede Buchung entsteht in **einer Transaktion** mit Audit-Eintrag und Outbox-Event; Belegnummern lückenlos je Nummernkreis (bestehende `Sequence`, aber nur für gebuchte Belege vergeben).
* Perioden können **gesperrt** werden; Buchen in gesperrte Perioden ist nicht möglich (Wiederöffnen nur mit Berechtigung und Begründung).
* Jeder Beleg verweist auf seine Quelle (Bestellung, Rechnung, Zahlung, Lohn-Export) – von der Auswertung bis zum Ursprungsbeleg nachvollziehbar.
* Aufbewahrung: Buchungsbelege sind in Österreich mehrere Jahre aufzubewahren (Dauer mit Steuerberatung bestätigen); Löschkonzept ist daher **Sperren/Anonymisieren statt Löschen** und gehört zur DSGVO-Planung.

## 4. Datenmodell (neu)

| Tabelle | Zweck / wichtige Felder |
|---|---|
| `Account` | Konto je Organisation: Nummer, Name, Klasse (Aktiva/Passiva/Aufwand/Ertrag), Normalseite, `postable`, Steuerstandard, aktiv; Hierarchie |
| `FiscalYear`, `FiscalPeriod` | Geschäftsjahr und Monatsperioden, Status OPEN/CLOSED |
| `JournalEntry` | Kopf: Belegnummer, Buchungsdatum, Periode, Status **DRAFT/POSTED**, Quelle (Typ+ID), `reversesId`, Text, Ersteller/Buchungsdatum |
| `JournalLine` | Zeile: Konto, Soll/Haben (Decimal), Währung/Fremdbetrag/Kurs, Kostenstelle, Steuerkennzeichen, Gegenkonto-Hinweis |
| `TaxCode` | Steuerkennzeichen: Satz (z. B. 20/13/10/0), Art (Vorsteuer/Umsatzsteuer/Reverse Charge/steuerfrei), Konten, UVA-Kennzahl |
| `SupplierInvoice` (+Zeilen) | Eingangsrechnung: Lieferant, Rechnungsnummer des Lieferanten (eindeutig je Lieferant), Datum, Fälligkeit, Beträge netto/Steuer/brutto, Verweis auf Bestellung, Status, Buchungsbeleg |
| `Customer` (minimal) | bis ein CRM existiert: Name, Anschrift, UID-Nummer, Zahlungsziel |
| `CustomerInvoice` (+Zeilen) | Ausgangsrechnung mit **lückenloser Nummer**, Rechnungsmerkmale, Status ENTWURF → AUSGESTELLT (unveränderlich) → BEZAHLT/STORNIERT; Gutschrift als eigener Beleg |
| `Payment`, `PaymentAllocation` | Zahlung (ein/aus) und Zuordnung zu einer oder mehreren Rechnungen (Teilzahlungen) |
| `BankAccount`, `BankTransaction` | importierte Kontoumsätze (camt.053/CSV), Abgleichstatus |
| `ExportRun` | Buchungsexport an die Steuerberatung (unveränderlich, Prüfsumme, Nachtrag-Logik wie beim Lohn-Export) |

Verknüpfungen zu Bestehendem: `PurchaseOrder` ↔ `SupplierInvoice`, `Budget` (Ist aus Buchungen statt nur gebundene Bestellungen), `CostCenter` in den Zeilen, `PayrollExport` → Sammelbuchung (optional).

## 5. Fachliche Abläufe

**Eingangsrechnung (Kreditoren)**
1. Erfassen (manuell, später Upload/OCR bewusst ausgeklammert): Lieferant, Rechnungsnummer, Beträge, Steuerkennzeichen.
2. **Dreifach-Abgleich** Bestellung ↔ Wareneingang ↔ Rechnung mit Toleranz (Betrag/Menge). Der **Wareneingang fehlt noch** (Beschaffung endet bei der Bestellung); bis dahin Abgleich Bestellung ↔ Rechnung, Wareneingang als Ausbaustufe.
3. Freigabe über die vorhandene **Genehmigungs-Engine** (Schwellen, mehrstufig).
4. Buchen (Aufwand/Vorsteuer an Kreditor), Fälligkeit, Zahlungsvorschlag, Zahlung, Ausgleich.
5. Budget: gebunden (Bestellung) → **fakturiert** (Rechnung) → bezahlt, je Kostenstelle sichtbar.

**Ausgangsrechnung (Debitoren)**
1. Entwurf, Prüfung, Ausstellen: vergibt die Nummer, friert den Beleg ein, erzeugt PDF (Rechnungsmerkmale nach UStG prüfen: Name/Anschrift, UID, Datum, Menge/Art, Entgelt, Steuersatz/-betrag, Nummer).
2. Buchen (Debitor an Erlös/Umsatzsteuer), Zahlung, Ausgleich; Gutschrift/Storno als Gegenbeleg.
3. Hook für **Kundenabrechnung nach Stunden** (Projekte + Zeiterfassung): Entwurf mit Positionen aus freigegebenen Zeiten, Zeiten danach gesperrt.

**Zahlungen und Bank**
Import von Kontoumsätzen; automatische **Vorschläge** zum Abgleich (Betrag, Referenz, IBAN), Bestätigung durch Benutzer; Zahlungsdatei für Überweisungen (pain.001) erst nach Freigabe. Keine Bankzugangsdaten im System; kein automatisches Auslösen von Zahlungen ohne Bestätigung.

**Periodenabschluss**
Prüfliste (offene Entwürfe, nicht gebuchte Rechnungen, unausgeglichene Posten), Sperren der Periode, Auswertungen, Export.

## 6. Berechtigungen (Vorschlag)

`finance.account.read/write`, `finance.journal.read`, `finance.journal.post`, `finance.journal.reverse`, `finance.period.close`, `finance.period.reopen`, `finance.invoice.in.create/approve`, `finance.invoice.out.create/issue`, `finance.payment.record`, `finance.bank.import`, `finance.report.read`, `finance.export.create`. Trennung der Aufgaben: wer eine Eingangsrechnung erfasst, gibt sie nicht frei; wer Zahlungen erfasst, bucht keine Rechnungen. Fremdwährungs- und Steuerkonfiguration nur für Finanzleitung/Inhaber.

## 7. Meilensteine

| # | Inhalt | Abnahme |
|---|---|---|
| F1 | **Buchhaltungskern**: Kontenplan (Vorlage importierbar), Geschäftsjahr/Perioden, Journal (Entwurf/Buchen), Storno, Trigger-Unveränderlichkeit, Saldenliste, Audit/Outbox | Σ Soll = Σ Haben (DB-Constraint + Test); gebuchte Zeilen nicht änderbar; gesperrte Periode lehnt Buchung ab; Storno hebt Salden exakt auf |
| F2 | **Steuer + Eingangsrechnung**: Steuerkennzeichen, Rechnungserfassung, Bestellabgleich, Freigabe über Engine, Buchung, Zahlung/Ausgleich, Offene Posten Kreditoren, Budget-Ist | Brutto = Netto + Steuer exakt; Rechnungsnummer je Lieferant eindeutig; Doppelzahlung verhindert; Budget zeigt fakturiert/bezahlt |
| F3 | **Ausgangsrechnung**: Kunden (minimal), Rechnungen mit lückenloser Nummer, PDF, Gutschrift, Offene Posten Debitoren | Nummernkreis lückenlos auch bei Parallelität; ausgestellte Rechnung unveränderlich; PDF reproduzierbar |
| F4 | **Bank**: Import, Abgleichsvorschläge, Zahlungsdatei | Teilzahlungen, Überzahlung, Rundungsdifferenzen korrekt; keine automatische Auslösung |
| F5 | **Auswertungen und Abschluss**: GuV, Bilanz, UVA-Vorschau, Periodenabschluss, Export an die Steuerberatung (Profil, Nachträge) | Bilanz stimmt mit Saldenliste überein (Test); Export reproduzierbar mit Prüfsumme |
| F6 | **Kundenabrechnung nach Stunden** (zusammen mit Projekten M11) | Zeiten → Rechnungsentwurf → ausgestellt → Zeiten gesperrt; Differenzen als Gutschrift |

Reihenfolge-Empfehlung: **F1 → F2** zuerst (schließt den Beschaffungsprozess und liefert Budget-Ist), danach Projekte (M11), dann F3/F6; F4/F5 je nach Bedarf der Steuerberatung vorziehen.

## 8. Testplan (Besonderheiten)

* **Eigenschaftstests:** für beliebige Buchungsfolgen gilt Σ Soll = Σ Haben je Beleg und je Periode; Storno + Original = 0; Reihenfolge der Buchungen ändert Salden nicht.
* **Rundung:** Steuerbeträge bei vielen Zeilen, Cent-Differenzen, Fremdwährung, 3-Dezimalstellen-Preise; Brutto/Netto-Umrechnung in beide Richtungen.
* **Nummernkreise:** parallele Ausstellung ohne Lücken oder Dubletten; Storno vergibt keine neue Nummer im Kreis der Originale (je Rechtslage).
* **Periodensperre und Trigger:** Direkter SQL-Zugriff kann gebuchte Zeilen nicht ändern.
* **Mandantentrennung und Berechtigung** wie bisher (Matrix für jede Operation); Aufgabentrennung (Ersteller ≠ Freigeber).
* **Abgleich Bestellung ↔ Rechnung ↔ Budget:** Kette bleibt konsistent bei Teilrechnungen, Gutschriften, Stornos.
* **E2E:** Bestellung → Rechnung erfassen → freigeben → bezahlen → Budget-Ist und Saldenliste im Browser; Barrierefreiheitsprüfung der neuen Seiten.

## 9. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Steuerliche Fehler (Sätze, Reverse Charge, Vorsteuerabzug, Istversteuerung) | Steuerkennzeichen konfigurierbar, mit Steuerberatung abnehmen; UVA nur als **Vorschau**; Pilotbetrieb mit paralleler Buchhaltung |
| Umfang (Buchhaltung ist groß) | strikte Meilensteine, F1/F2 liefern bereits Nutzen; keine Anlagen-/Kostenrechnung |
| Unveränderlichkeit vs. Fehlerkorrektur | Storno-Workflow mit klarer Oberfläche; Entwurfsstatus vor dem Buchen |
| Datenschutz/Aufbewahrung | Sperren/Anonymisieren statt Löschen, mit Fristen aus der Beratung |
| Kontenrahmen-/Exportformate unbekannt | Zuordnungsprofil wie beim Lohn-Export; Zielsystem früh klären |
| Leistung bei großen Journalen | Indizes (Konto+Datum), Saldenverdichtung je Periode (abgeleitet, neu berechenbar) |
| Fehlbedienung bei Zahlungen | Vorschläge statt Automatik, Vier-Augen-Prinzip für Zahlungsdateien |

## 10. Offene Fragen an dich (mit Empfehlung)

1. Bucht das Unternehmen **selbst** oder nur Export an die Steuerberatung? *(bestimmt, ob F5 wichtig ist oder F1/F2 + Export genügen)*
2. Welche **Buchhaltungssoftware** nutzt die Steuerberatung (BMD, RZL, DATEV, …)?
3. **Soll- oder Istversteuerung**, welche Umsatzsteuersätze/Sonderfälle (Reverse Charge, innergemeinschaftlich)?
4. Werden **Fremdwährungen** gebraucht?
5. Soll **Kundenabrechnung** das erste Ziel nach F2 sein (dann Projekte M11 vorziehen)?
6. Braucht ihr **Wareneingang** (3-Wege-Abgleich) oder genügt Bestellung ↔ Rechnung?
7. Pilotbetrieb: gibt es einen konkreten Betrieb mit Echtdaten (Anonymisierung beachten)?
