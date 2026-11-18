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
| Demo-Daten | ausschließlich synthetisch |

## Bekannte Lücken (offen)
* Postgres Row-Level-Security noch nicht aktiv.
* MFA nicht umgesetzt.
* Rate Limiting zunächst in-memory (nicht verteilt).
* Login-Sperre (5 Fehlversuche/15 Min je Konto) kann Konten fremder Personen blockieren; Gegenmaßnahme: MFA, IP-Drosselung.
* Kein DSGVO-Löschkonzept für Mitarbeiterdaten (Anonymisierung/Aufbewahrung) – vor Produktivbetrieb nötig.

## Meldung
Sicherheitslücken bitte per GitHub „Security Advisories" melden, nicht als öffentliches Issue.
