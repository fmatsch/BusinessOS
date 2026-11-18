# Wareneingang und Rechnungsabgleich (M13)

Status: **umgesetzt** (Schritte 1–4 des ursprünglichen Plans); Schritt 5 (Budget „Ist“ aus Rechnungen, `finance/queries.ts` → `budgetOverview`) ist ebenfalls umgesetzt.

## Was es tut
* **Wareneingang** je Bestellung und Bestellposition (Teillieferungen möglich); Lieferstatus „nichts geliefert / teilgeliefert / vollständig“.
* **Drei-Wege-Abgleich** beim Freigeben einer Eingangsrechnung **mit Bestellbezug**: Die Netto-Rechnung darf den Wert der gelieferten, noch nicht abgerechneten Ware und den offenen Bestellwert nicht übersteigen. Toleranz: die größere von **2 % der Rechnungssumme oder 5 €** (feste Voreinstellung, `DEFAULT_TOLERANCE` in `modules/finance/match.ts`).
* Bei Abweichung ist die **Freigabe gesperrt**, bis eine Person mit `finance.invoice.in.accept_variance` die Abweichung mit Begründung akzeptiert (nicht die erfassende Person; im Audit-Log).
* Rechnungen **ohne Bestellung** (z. B. Miete) und Gutschriften werden nicht abgeglichen.

## Umsetzung (abweichend vom ersten Plan)
* `GoodsReceipt`/`GoodsReceiptLine`: append-only (DB-Trigger); Korrektur nur als Gegenbuchung (`reversesId`, höchstens einmal je Wareneingang). Mengen beziehen sich auf die Positionen der Bestellanforderung (Bestellungen haben keine eigenen Positionen).
* Kein Abgleich je Rechnungsposition: Rechnungspositionen tragen keine Menge, daher wird der **Wert** (Menge × Bestellpreis) verglichen.
* Überlieferung ist nicht möglich (Menge ≤ offene Bestellmenge); parallele Buchungen sind per Zeilensperre auf der Bestellung abgesichert. Ebenso sperrt die Rechnungsfreigabe die Bestellung, damit parallele Freigaben den Abgleich nicht umgehen.
* Berechtigungen: `procurement.receipt.create`/`.read` (Führungskraft, Finanzen, Inhaber), `finance.invoice.in.accept_variance` (Finanzen, Inhaber). **Bestehende Organisationen** brauchen die neuen Berechtigungen in ihren Rollen (`npx prisma db seed` für die Demo; produktiv per Rollen-Sync).

## Grenzen
* Toleranz ist noch nicht je Organisation oder Lieferant einstellbar; der Abgleich ist Pflicht (nur mit Bestellbezug).
* Eine Korrektur des Wareneingangs nach einer bereits freigegebenen Rechnung ändert diese nicht; der Stand wird beim nächsten Abgleich zur Bestellung berücksichtigt.
* Kein Wareneingang für Bestellungen ohne Anforderungspositionen, keine Lieferscheine/Seriennummern, keine Lagerführung.
