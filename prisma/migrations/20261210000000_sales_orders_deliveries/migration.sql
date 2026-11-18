-- CreateTable
CREATE TABLE "SalesOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "number" TEXT,
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "orderDate" DATE NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "SalesOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "itemId" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitPrice" DECIMAL(19,4) NOT NULL,
    "taxCodeId" TEXT NOT NULL,
    "revenueAccountId" TEXT,

    CONSTRAINT "SalesOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "shippedOn" DATE,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shippedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryLine" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "locationId" TEXT,
    "batchNumber" TEXT,
    "serials" TEXT,
    "movementIds" TEXT[],
    "invoiceId" TEXT,

    CONSTRAINT "DeliveryLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesOrder_organizationId_customerId_idx" ON "SalesOrder"("organizationId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrder_organizationId_number_key" ON "SalesOrder"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderLine_orderId_position_key" ON "SalesOrderLine"("orderId", "position");

-- CreateIndex
CREATE INDEX "Delivery_organizationId_orderId_idx" ON "Delivery"("organizationId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_organizationId_number_key" ON "Delivery"("organizationId", "number");

-- CreateIndex
CREATE INDEX "DeliveryLine_deliveryId_idx" ON "DeliveryLine"("deliveryId");

-- CreateIndex
CREATE INDEX "DeliveryLine_orderLineId_idx" ON "DeliveryLine"("orderLineId");

-- AddForeignKey
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLine" ADD CONSTRAINT "DeliveryLine_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLine" ADD CONSTRAINT "DeliveryLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "SalesOrderLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "SalesOrder" ADD CONSTRAINT "SalesOrder_status_check" CHECK ("status" IN ('DRAFT', 'CONFIRMED', 'CLOSED', 'CANCELLED'));
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_status_check" CHECK ("status" IN ('DRAFT', 'SHIPPED', 'CANCELLED'));
ALTER TABLE "SalesOrderLine" ADD CONSTRAINT "SalesOrderLine_quantity_check" CHECK ("quantity" > 0 AND "unitPrice" >= 0);
ALTER TABLE "DeliveryLine" ADD CONSTRAINT "DeliveryLine_quantity_check" CHECK ("quantity" > 0);

-- Auftragspositionen sind nur im Entwurf änderbar
CREATE OR REPLACE FUNCTION sales_order_line_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM "SalesOrder" WHERE id = OLD."orderId";
  IF st IS NOT NULL AND st <> 'DRAFT' THEN RAISE EXCEPTION 'Positionen bestätigter Aufträge sind unveränderlich'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SalesOrderLine_guard" BEFORE UPDATE OR DELETE ON "SalesOrderLine" FOR EACH ROW EXECUTE FUNCTION sales_order_line_guard();

-- Lieferungen: versandte sind unveränderlich (nur Storno); stornierte sind endgültig
CREATE OR REPLACE FUNCTION sales_delivery_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Versandte oder stornierte Lieferungen dürfen nicht gelöscht werden'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'CANCELLED' THEN RAISE EXCEPTION 'Stornierte Lieferungen sind unveränderlich'; END IF;
  IF OLD.status = 'SHIPPED' AND NEW.status NOT IN ('SHIPPED', 'CANCELLED') THEN RAISE EXCEPTION 'Versandte Lieferungen können nur storniert werden'; END IF;
  IF OLD.status = 'SHIPPED' AND NEW.status = 'SHIPPED' AND (NEW."orderId" <> OLD."orderId" OR NEW.number IS DISTINCT FROM OLD.number OR NEW."shippedOn" IS DISTINCT FROM OLD."shippedOn") THEN
    RAISE EXCEPTION 'Versandte Lieferungen sind unveränderlich';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Delivery_guard" BEFORE UPDATE OR DELETE ON "Delivery" FOR EACH ROW EXECUTE FUNCTION sales_delivery_guard();

-- Lieferpositionen versandter Lieferungen: nur die Abrechnung (invoiceId, einmalig) darf gesetzt werden
CREATE OR REPLACE FUNCTION sales_delivery_line_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM "Delivery" WHERE id = OLD."deliveryId";
  IF st IS NOT NULL AND st <> 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Zeilen versandter Lieferungen sind unveränderlich'; END IF;
    IF NEW."orderLineId" <> OLD."orderLineId" OR NEW.quantity <> OLD.quantity OR NEW."locationId" IS DISTINCT FROM OLD."locationId" OR NEW."batchNumber" IS DISTINCT FROM OLD."batchNumber" OR NEW.serials IS DISTINCT FROM OLD.serials OR NEW."movementIds" IS DISTINCT FROM OLD."movementIds" OR (OLD."invoiceId" IS NOT NULL AND NEW."invoiceId" IS DISTINCT FROM OLD."invoiceId") THEN
      RAISE EXCEPTION 'Zeilen versandter Lieferungen sind unveränderlich';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DeliveryLine_guard" BEFORE UPDATE OR DELETE ON "DeliveryLine" FOR EACH ROW EXECUTE FUNCTION sales_delivery_line_guard();
