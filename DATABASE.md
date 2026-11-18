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
* `Sequence`: atomare Nummernkreise je Organisation (`PR-2026-0001`, `PO-2026-0001`)
* `PurchaseOrder` 1—n `PurchaseOrderLine`, verweist auf `PurchaseRequest`, `Supplier`, `CostCenter`
* `Budget` je `CostCenter` und Geschäftsjahr; *committed* = Summe offener Bestellungen (abgeleitet)

**Weitere (Schema vorbereitet, Funktion später)**
`Account`, `JournalEntry`, `JournalLine`, `Invoice`, `Payment`, `StockMovement`, `Project`, `Task`, `WorkflowDefinition` (versioniert), `WorkflowInstance`.

## Integritätsregeln
* `JournalEntry`: Σ Soll = Σ Haben; gebucht ⇒ unveränderlich; Storno über `reversesId`.
* `StockMovement`: append-only; Bestand = Summe der Bewegungen, in Transaktion geprüft (kein negativer Bestand ohne Erlaubnis).
* `PurchaseOrder` erzeugt in einer Transaktion: Bestellung + Budget-Commit + AuditLog + OutboxEvent.

## Migrationen
Nur über `prisma migrate dev` / `migrate deploy`. Keine manuellen Schemaänderungen. Jede Migration wird committet.
