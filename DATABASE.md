# Datenmodell

Quelle der Wahrheit: [`prisma/schema.prisma`](prisma/schema.prisma). Dieses Dokument beschreibt Konventionen und Beziehungen.

## Konventionen
* Primärschlüssel: `cuid` (String).
* Jede fachliche Tabelle: `organizationId`, `createdAt`, `updatedAt`; Index auf `organizationId`.
* Geld: `Decimal(19,4)` plus `currency` (ISO 4217). Menge: `Decimal(19,4)`.
* Gebuchte Daten werden nicht gelöscht; Statusfelder und Storno.
* Eindeutigkeit immer pro Organisation, z. B. `@@unique([organizationId, number])`.

## Entitäten und Beziehungen

**Plattform**
* `Tenant` 1—n `Organization`
* `User` n—m `Organization` über `OrganizationMembership` (jeweils mit `Role`)
* `Role` n—m `Permission` (`RolePermission`); Rollen gehören zu einer Organisation
* `AuditLog`: wer (User/KI), was, welche Entität, Vorher/Nachher (JSON), Organisation
* `OutboxEvent`: Domain Events, `processedAt`, `attempts`
* `Notification`: Empfänger, Text, Lesestatus

**Stammdaten**
* `Department` (hierarchisch via `parentId`), `CostCenter` (optional Abteilung)
* `Employee` → `Department`, optional `User`; sensible Felder getrennt (`EmployeeSensitive`)
* `Customer`, `Supplier`, `Product`, `Warehouse`

**Beschaffung (MVP-Prozess)**
* `PurchaseRequest` 1—n `PurchaseRequestLine`; Status `DRAFT → SUBMITTED → APPROVED | REJECTED → ORDERED`
* `Approval`: Freigabeschritt je Antrag (`MANAGER`, bei > 5.000 zusätzlich `FINANCE`), Reihenfolge über `sequence`, Entscheidung, Kommentar
* `ApprovalPolicy`: versionierte Freigaberegel je Organisation/Objektart (`steps` als JSON, neue Version = neue Zeile); `PurchaseRequest.policyVersion` und `Approval.requiredPermission` halten den Stand beim Einreichen fest
* `OutboxEvent`: `attempts`, `nextAttemptAt`, `lastError`, `failedAt` (Dead Letter); `Notification`: `dedupeKey` (eindeutig), `href`, `type`
* `Sequence`: atomare Nummernkreise je Organisation (`PR-2026-0001`, `PO-2026-0001`)
* `PurchaseOrder` 1—n `PurchaseOrderLine`, verweist auf `PurchaseRequest`, `Supplier`, `CostCenter`
* `Budget` je `CostCenter` und Geschäftsjahr; *committed* = Summe offener Bestellungen (abgeleitet)

**HR (M7)**
* `Employee` (Personalnummer je Organisation eindeutig, `managerId` Hierarchie, `userId` optional), `EmployeeSensitive` (getrennt), `Employment` (Zeiträume, ohne Überschneidung im Service unter Zeilensperre)
* `AbsenceType`, `AbsenceRequest` (Status, Arbeitstage), `Approval.absenceRequestId` (CHECK: genau ein Bezug – Bestellanforderung oder Abwesenheit)
* `LeaveBalanceEntry`: Journal je Mitarbeiter/Jahr (`ENTITLEMENT`, `CARRYOVER`, `ADJUSTMENT`, `TAKEN`, `REVERSAL`), Trigger verbietet UPDATE und DELETE (Ausnahme nur mit `app.allow_journal_delete` in derselben Transaktion)

**Dienstplanung (M8)**
* `Site` (Zeitzone), `Qualification`/`EmployeeQualification`, `ShiftTemplate`, `RosterRules` (Grenzwerte je Organisation)
* `Roster` (Plan je Standort/Zeitraum, `publishedVersion`, `dirty`) 1—n `Shift` 1—n `ShiftAssignment`; Zeiten als UTC, `localDate` = Ortsdatum des Beginns
* `RosterVersion`: unveränderlicher Snapshot + Änderungsprotokoll (Trigger verbietet UPDATE/DELETE); `PublishedShift`: Projektion der jüngsten Version je Person (für „Mein Dienstplan", iCal)
* `ShiftSwapRequest` (PENDING_PEER → PENDING_APPROVAL → APPROVED/REJECTED/CANCELLED)

**Zeiterfassung (M9)**
* `TimeClock` (laufende Stempelung, flüchtig) → `TimeEntry`: **Journal** (`kind` WORK | REVERSAL, `reversesId` eindeutig, `replacesId` bei Korrektur; Trigger verbietet UPDATE/DELETE); wirksam = WORK ohne Gegenbuchung
* `TimeEntryRequest` (ADD | CORRECT | DELETE mit Begründung und Freigabe), `TimesheetPeriod` (OPEN → SUBMITTED → APPROVED, `summary` zum Freigabezeitpunkt)
* `TimeAccountEntry`: Zeitkonto-Journal in Minuten (PERIOD | REVERSAL | ADJUSTMENT), append-only; Saldo = Summe
* `PayCodeRule`: Zuschlagsprozente je Kategorie (Konfiguration für M10)

**Lohn-Export (M10)**
* `PayrollProfile` (Format und Lohnart-Zuordnung je Organisation), `PayrollExport` (Lauf je Monat, `version` 1 = Erstexport, ab 2 = Nachtrag, Inhalt, `contentHash`, Profil-Snapshot, Prüfergebnis, ausgelassene Beschäftigte), `PayrollExportLine` (Menge je Mitarbeiter/Lohnart, in Nachträgen als Differenz)
* Läufe und Zeilen sind unveränderlich (Trigger); Summe aller Zeilen eines Monats = exportierter Stand

**Finance (Belegerfassung und Export)**
`Account`, `TaxCode`, `Customer`, `FinanceFile` (Belegdatei, Hash), `SupplierInvoice`/`Line`, `CustomerInvoice`/`Line`, `AccountingProfile`, `AccountingExport`/`Item`; `Supplier` um UID und Konten erweitert. Teilindex `SupplierInvoice_supplier_number_active` (keine Dubletten aktiver Rechnungen); Trigger machen Exportläufe und -positionen unveränderlich; ein Beleg steht höchstens einmal in einem Lauf (Unique org+Art+Beleg).

**Wareneingang**
`GoodsReceipt` (je Bestellung, `reversesId` für Gegenbuchungen, eindeutig) und `GoodsReceiptLine` (Bestellposition, Menge; Gegenbuchung negativ) – per Trigger append-only. `SupplierInvoice` um `varianceAcceptedById/At/Reason` erweitert.

**Weitere (Schema vorbereitet, Funktion später)**
Noch **nicht im Schema** (nur geplant): Hauptbuch (`JournalEntry`, `JournalLine`, Zahlungen – bewusst nicht geplant, siehe [FINANCE.md](FINANCE.md)), `Product`, `Warehouse`, `StockMovement`, `Project`, `Task`, `WorkflowDefinition` (versioniert), `WorkflowInstance`.

## Integritätsregeln
* `JournalEntry`: Σ Soll = Σ Haben; gebucht ⇒ unveränderlich; Storno über `reversesId`.
* `StockMovement`: append-only; Bestand = Summe der Bewegungen, in Transaktion geprüft (kein negativer Bestand ohne Erlaubnis).
* `PurchaseOrder` erzeugt in einer Transaktion: Bestellung + Budget-Commit + AuditLog + OutboxEvent.

## Migrationen
Nur über `prisma migrate dev` / `migrate deploy`. Keine manuellen Schemaänderungen. Jede Migration wird committet.
