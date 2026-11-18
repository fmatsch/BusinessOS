# Sicherheit

## Grundsätze
1. **Serverseitige Autorisierung für jede geschützte Operation** – Frontend-Filter sind nie eine Sicherheitsmaßnahme.
2. **Mandantentrennung**: jede Query ist an `organizationId` aus der serverseitig geprüften Mitgliedschaft gebunden. Nie aus Client-Eingaben.
3. **Least Privilege**: Standardrollen erhalten nur nötige Permissions; HR-Sensibles separat.
4. **Audit**: alle schreibenden Operationen und KI-Aktionen werden protokolliert; Einträge sind append-only.

## Maßnahmen
| Bereich | Umsetzung |
|---|---|
| Passwörter | bcrypt (Kostenfaktor ≥ 12), Mindestlänge 12 |
| Sessions | Auth.js JWT, httpOnly, Secure, SameSite=Lax |
| Eingaben | Zod an jeder Grenze (Server Actions, API) |
| Rate Limiting | Login und KI-Endpunkte (Phase 2/4) |
| CSRF | Server Actions / SameSite-Cookies |
| XSS | React-Escaping, keine `dangerouslySetInnerHTML`, CSP-Header |
| Header | `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, CSP in `next.config` |
| Secrets | nur über Umgebungsvariablen, nie im Browser-Bundle (kein `NEXT_PUBLIC_` für Schlüssel), `.env` ist ignoriert |
| Fehler | generische Meldungen an Clients, Details nur im Server-Log |
| Uploads | Typ- und Größenprüfung, Speicherung außerhalb des Webroots (Phase später) |
| KI | nur lesende Tools mit Benutzerkontext, kein freies SQL, Werkzeugdaten als `<untrusted_data>` gekapselt, Quellen serverseitig, Audit jeder Aktion, Rate-Limit; Schreibzugriffe gibt es nicht (später nur mit Bestätigung) |
| DSGVO | Datenminimierung, Löschkonzept für personenbezogene Daten, Auskunftsfähigkeit über Audit-Log |
| HR-Daten | persönliche Angaben getrennt gespeichert, eigene Berechtigung, Lesezugriffe im Audit-Log (ohne Inhalte); Vertragsdaten nur Personal/Person selbst; Krankenstand ohne Diagnosen; Urlaubsjournal per Trigger unveränderlich |
| Zeitdaten | eigene Daten, direkte Führungskraft nur Team, Personalwesen alle; Fremdzugriffe im Audit-Log; Buchungs- und Zeitkonto-Journal per Trigger unveränderlich; Korrekturen nur mit Begründung und Freigabe; keine Ortung/Aktivitätsmessung |
| Lohn-Export | nur Personalwesen/Inhaber erzeugen, Finanzen darf lesen; Läufe unveränderlich mit Prüfsumme (beim Download geprüft); Download und Export im Audit-Log; CSV-Felder gegen Formel-Injection geschützt; keine Zugangsdaten zu Lohnsystemen gespeichert |
| Demo-Daten | ausschließlich synthetisch |

## Finance (Belege und Export)
* Beleg-Upload: Typ nur per Inhaltsprüfung (PDF/PNG/JPEG), max. 8 MB, sichere Dateinamen, SHA-256 geprüft; Auslieferung mit `nosniff` und restriktiver CSP.
* Eingangsrechnungen: Vier-Augen-Freigabe (Erfasser ≠ Freigebender), Dublettenprüfung, Stornierung nur vor dem Export.
* Exportläufe unveränderlich (DB-Trigger), Prüfsumme beim Download geprüft, jeder Download und Export im Audit-Log; paralleler Lauf je Organisation serialisiert.
* Ausgangsrechnungsnummern lückenlos; Berechtigungen getrennt (Erfassen/Freigeben/Export lesen/erzeugen), Test in der Berechtigungsmatrix.
* Wareneingänge sind append-only; Rechnungen mit Abweichung vom Abgleich lassen sich nur mit eigener Berechtigung, Begründung und nicht durch die erfassende Person freigeben (Audit-Log); Bestellungen werden bei Buchung und Freigabe zeilengesperrt (parallele Läufe).
* CRM: Kontakte sind personenbezogen; Löschwunsch per Anonymisierung (eigene Berechtigung `crm.contact.erase`), Audit-Einträge enthalten nur Kennungen. Angebote brauchen eine Freigabe durch eine andere Person (Vier-Augen) und sind nach dem Versenden unveränderlich.
* Bankauszüge: eigener XML-Leser ohne DTD/Entitäten (keine Entity-Expansion), Größen- und Zeilengrenzen, Berechtigung `finance.bank.manage`; Zahlungsvermerke tragen die Herkunft (`bankLineId`) im Audit-Log.
* Spesen: Belege werden wie Finanzbelege am Inhalt geprüft und mit Prüfsumme gespeichert; Zugriff nur für die Person, die direkte Führungskraft und `expense.read_all`; fremde Abrechnungen sind für Unbeteiligte nicht erkennbar (404).
* KI-Schreibvorschläge: nur `propose_*`-Werkzeuge; Ausführung ausschließlich durch die bestätigende Person über den Service mit ihren Rechten (nie Modell, nie Service-Konto); Beschreibung aus geprüften Daten; Frist 15 Minuten, einmalig (Beanspruchung per Statuswechsel), Audit (`ai.proposal` als KI, `ai.proposal_confirmed` als Person). Freigaben, Löschungen, Zahlungen sind nicht als Werkzeug vorhanden.
* Analysen: feste Berichte hinter doppeltem Rechtecheck, kein freies SQL; CSV-Export mit Formelschutz und Audit-Eintrag; Workflows senden nur Benachrichtigungen (keine Datenänderung, keine externen Aufrufe), Texte werden nie als HTML ausgegeben.

## Bekannte Lücken (offen)
* Postgres Row-Level-Security noch nicht aktiv.
* MFA nicht umgesetzt.
* Rate Limiting zunächst in-memory (nicht verteilt).
* Login-Sperre (5 Fehlversuche/15 Min je Konto) kann Konten fremder Personen blockieren; Gegenmaßnahme: MFA, IP-Drosselung.
* Kein DSGVO-Löschkonzept für Mitarbeiterdaten (Anonymisierung/Aufbewahrung) – vor Produktivbetrieb nötig.

## Meldung
Sicherheitslücken bitte per GitHub „Security Advisories" melden, nicht als öffentliches Issue.
