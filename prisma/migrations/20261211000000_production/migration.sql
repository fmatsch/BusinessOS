-- CreateTable
CREATE TABLE "Bom" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "outputQuantity" DECIMAL(19,4) NOT NULL DEFAULT 1,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "Bom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BomLine" (
    "id" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "componentItemId" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "scrapPercent" DECIMAL(7,2) NOT NULL DEFAULT 0,

    CONSTRAINT "BomLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT,
    "itemId" TEXT NOT NULL,
    "bomId" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "plannedDate" DATE,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "ProductionOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionConfirmation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "componentLocationId" TEXT,
    "outputLocationId" TEXT,
    "batchNumber" TEXT,
    "serials" TEXT,
    "movementIds" TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reverseReason" TEXT,

    CONSTRAINT "ProductionConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bom_organizationId_itemId_version_key" ON "Bom"("organizationId", "itemId", "version");

-- CreateIndex
CREATE INDEX "ProductionOrder_organizationId_itemId_idx" ON "ProductionOrder"("organizationId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOrder_organizationId_number_key" ON "ProductionOrder"("organizationId", "number");

-- CreateIndex
CREATE INDEX "ProductionConfirmation_orderId_idx" ON "ProductionConfirmation"("orderId");

-- AddForeignKey
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_bomId_fkey" FOREIGN KEY ("bomId") REFERENCES "Bom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionConfirmation" ADD CONSTRAINT "ProductionConfirmation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProductionOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Je Artikel höchstens eine aktive Stückliste
CREATE UNIQUE INDEX "Bom_one_active" ON "Bom"("organizationId", "itemId") WHERE "status" = 'ACTIVE';
ALTER TABLE "Bom" ADD CONSTRAINT "Bom_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'ARCHIVED'));
ALTER TABLE "Bom" ADD CONSTRAINT "Bom_output_check" CHECK ("outputQuantity" > 0);
ALTER TABLE "BomLine" ADD CONSTRAINT "BomLine_check" CHECK ("quantity" > 0 AND "scrapPercent" >= 0 AND "scrapPercent" < 100);
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_status_check" CHECK ("status" IN ('DRAFT', 'RELEASED', 'COMPLETED', 'CANCELLED'));
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "ProductionConfirmation" ADD CONSTRAINT "ProductionConfirmation_quantity_check" CHECK ("quantity" > 0);

-- Stücklistenzeilen nur im Entwurf änderbar
CREATE OR REPLACE FUNCTION bom_line_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM "Bom" WHERE id = OLD."bomId";
  IF st IS NOT NULL AND st <> 'DRAFT' THEN RAISE EXCEPTION 'Zeilen aktivierter Stücklisten sind unveränderlich'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "BomLine_guard" BEFORE UPDATE OR DELETE ON "BomLine" FOR EACH ROW EXECUTE FUNCTION bom_line_guard();

-- Stückliste: nach der Aktivierung nur noch archivieren
CREATE OR REPLACE FUNCTION bom_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Aktivierte Stücklisten dürfen nicht gelöscht werden'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'ARCHIVED' THEN RAISE EXCEPTION 'Archivierte Stücklisten sind unveränderlich'; END IF;
  IF OLD.status = 'ACTIVE' AND (NEW.status <> 'ARCHIVED' OR NEW."outputQuantity" <> OLD."outputQuantity" OR NEW."itemId" <> OLD."itemId") THEN
    RAISE EXCEPTION 'Aktivierte Stücklisten sind gesperrt (nur archivieren)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Bom_guard" BEFORE UPDATE OR DELETE ON "Bom" FOR EACH ROW EXECUTE FUNCTION bom_guard();

-- Rückmeldungen: unveränderlich, nur die Rücknahme (einmalig) darf gesetzt werden
CREATE OR REPLACE FUNCTION production_confirmation_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Rückmeldungen dürfen nicht gelöscht werden'; END IF;
  IF OLD."reversedAt" IS NOT NULL OR NEW.quantity <> OLD.quantity OR NEW."orderId" <> OLD."orderId" OR NEW."movementIds" IS DISTINCT FROM OLD."movementIds" THEN
    RAISE EXCEPTION 'Rückmeldungen sind unveränderlich';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ProductionConfirmation_guard" BEFORE UPDATE OR DELETE ON "ProductionConfirmation" FOR EACH ROW EXECUTE FUNCTION production_confirmation_guard();
