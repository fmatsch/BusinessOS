# Plan: Wareneingang und Rechnungsabgleich (M13)

Status: **Plan, noch nicht umgesetzt.** Ziel: Eingangsrechnungen gegen Bestellung und tatsächlich gelieferte Menge prüfen (Drei-Wege-Abgleich), bevor sie zur Freigabe gehen.

## Nutzen
* Rechnungen werden nur freigegeben, wenn Menge und Preis zur Bestellung und zum Wareneingang passen (oder eine Abweichung begründet akzeptiert wird).
* Bestellungen zeigen Lieferstatus (offen / teilgeliefert / vollständig) und den bereits abgerechneten Betrag.
* Budget: Bindung aus Bestellung wird durch den tatsächlich gebuchten Rechnungsbetrag ersetzt (Ist statt Plan).

## Datenmodell (neu)
* `GoodsReceipt` (Wareneingang: Bestellung, Datum, Erfasser, Notiz) und `GoodsReceiptLine` (Bestellposition, Menge) – **append-only**; Korrekturen als Gegenbuchung (negative Menge) statt Änderung.
* `PurchaseOrderLine` bekommt abgeleitete Summen (geliefert, abgerechnet) – berechnet, nicht gespeichert.
* `SupplierInvoice.purchaseOrderId` existiert bereits; neu: `SupplierInvoiceLine.purchaseOrderLineId` (optional).
* `MatchResult` je Rechnung: Status (OK / ABWEICHUNG / AKZEPTIERT), Abweichungen als Liste, Toleranz aus Organisationseinstellung (Prozent und Betrag), wer hat akzeptiert und warum.

## Regeln
1. Wareneingang nur für freigegebene, bestellte Positionen; Menge darf bestellte Restmenge nicht überschreiten (Übermenge nur mit Berechtigung und Begründung).
2. Abgleich je Rechnungsposition: Menge ≤ geliefert − bereits abgerechnet; Preis innerhalb Toleranz. Ergebnis wird beim Erfassen und bei Wareneingängen neu berechnet.
3. Abweichung blockiert die Freigabe, bis jemand mit Berechtigung `finance.invoice.in.accept_variance` mit Begründung akzeptiert (Vier-Augen bleibt bestehen).
4. Alles in `prisma.$transaction` mit AuditLog + OutboxEvent; Mandantenfilter und `authorize` wie üblich; Geld nur `Decimal`.
5. Neue Berechtigungen: `procurement.receipt.create`, `procurement.receipt.read`, `finance.invoice.in.accept_variance`.

## Umsetzung in Schritten
1. Schema + Migration + Berechtigungen, Abgleichslogik als **reine, getestete Funktion** (`modules/finance/match.ts`).
2. Service: Wareneingang erfassen/lesen/stornieren, Lieferstatus, Abgleich bei Rechnungserfassung.
3. UI: Wareneingang an der Bestellung, Abgleichsanzeige an der Eingangsrechnung, Abweichung akzeptieren.
4. Tests: Unit (Toleranzen, Teillieferung, Gutschrift), DB-Fluss, Berechtigungsmatrix, Mandantentrennung, E2E.
5. Budget „Ist“ aus freigegebenen Rechnungen (eigener Schritt, ändert Budgetanzeige).

## Offene Fragen an Sie
* Toleranz: feste Voreinstellung (z. B. 2 % / 5 €) oder je Lieferant?
* Soll der Abgleich Pflicht sein oder nur Hinweis?
* Rechnungen ohne Bestellung (z. B. Miete): weiterhin ohne Abgleich erlaubt?
