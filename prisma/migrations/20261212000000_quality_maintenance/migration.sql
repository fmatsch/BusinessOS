-- CreateTable
CREATE TABLE "InspectionPlan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),

    CONSTRAINT "InspectionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionCharacteristic" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT,
    "minValue" DECIMAL(19,6),
    "maxValue" DECIMAL(19,6),

    CONSTRAINT "InspectionCharacteristic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inspection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "batchNumber" TEXT,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "reference" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "deviation" BOOLEAN NOT NULL DEFAULT false,
    "decisionNote" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "Inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InspectionResult" (
    "id" TEXT NOT NULL,
    "inspectionId" TEXT NOT NULL,
    "characteristicId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT,
    "minValue" DECIMAL(19,6),
    "maxValue" DECIMAL(19,6),
    "value" DECIMAL(19,6),
    "passed" BOOLEAN NOT NULL,
    "note" TEXT,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InspectionResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NonConformance" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "inspectionId" TEXT,
    "itemId" TEXT,
    "description" TEXT NOT NULL,
    "cause" TEXT,
    "action" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "NonConformance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceObject" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "fixedAssetId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceObject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePlan" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT,
    "intervalUnit" TEXT NOT NULL,
    "intervalValue" INTEGER NOT NULL,
    "nextDueOn" DATE NOT NULL,
    "lastDoneOn" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenancePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceOrder" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "planId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dueOn" DATE,
    "reportedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "doneOn" DATE,
    "doneById" TEXT,
    "report" TEXT,
    "minutesSpent" INTEGER,

    CONSTRAINT "MaintenanceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenancePart" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "movementIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenancePart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InspectionPlan_organizationId_itemId_version_key" ON "InspectionPlan"("organizationId", "itemId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCharacteristic_planId_position_key" ON "InspectionCharacteristic"("planId", "position");

-- CreateIndex
CREATE INDEX "Inspection_organizationId_itemId_idx" ON "Inspection"("organizationId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "Inspection_organizationId_number_key" ON "Inspection"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "InspectionResult_inspectionId_characteristicId_key" ON "InspectionResult"("inspectionId", "characteristicId");

-- CreateIndex
CREATE UNIQUE INDEX "NonConformance_organizationId_number_key" ON "NonConformance"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceObject_organizationId_number_key" ON "MaintenanceObject"("organizationId", "number");

-- CreateIndex
CREATE INDEX "MaintenanceOrder_organizationId_objectId_idx" ON "MaintenanceOrder"("organizationId", "objectId");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceOrder_organizationId_number_key" ON "MaintenanceOrder"("organizationId", "number");

-- CreateIndex
CREATE INDEX "MaintenancePart_orderId_idx" ON "MaintenancePart"("orderId");

-- AddForeignKey
ALTER TABLE "InspectionCharacteristic" ADD CONSTRAINT "InspectionCharacteristic_planId_fkey" FOREIGN KEY ("planId") REFERENCES "InspectionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InspectionResult" ADD CONSTRAINT "InspectionResult_inspectionId_fkey" FOREIGN KEY ("inspectionId") REFERENCES "Inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "MaintenanceObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceOrder" ADD CONSTRAINT "MaintenanceOrder_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "MaintenanceObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceOrder" ADD CONSTRAINT "MaintenanceOrder_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MaintenancePlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenancePart" ADD CONSTRAINT "MaintenancePart_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "MaintenanceOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Qualitätsmanagement ──
CREATE UNIQUE INDEX "InspectionPlan_one_active" ON "InspectionPlan"("organizationId", "itemId") WHERE "status" = 'ACTIVE';
ALTER TABLE "InspectionPlan" ADD CONSTRAINT "InspectionPlan_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'ARCHIVED'));
ALTER TABLE "InspectionCharacteristic" ADD CONSTRAINT "InspectionCharacteristic_check" CHECK (
  "kind" IN ('QUANTITATIVE', 'QUALITATIVE')
  AND ("kind" = 'QUALITATIVE' OR "minValue" IS NOT NULL OR "maxValue" IS NOT NULL)
  AND ("minValue" IS NULL OR "maxValue" IS NULL OR "minValue" <= "maxValue")
);
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_status_check" CHECK ("status" IN ('OPEN', 'ACCEPTED', 'REJECTED'));
ALTER TABLE "Inspection" ADD CONSTRAINT "Inspection_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "NonConformance" ADD CONSTRAINT "NonConformance_status_check" CHECK ("status" IN ('OPEN', 'CLOSED'));

-- Merkmale eines aktivierten Prüfplans sind gesperrt
CREATE OR REPLACE FUNCTION inspection_characteristic_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM "InspectionPlan" WHERE id = OLD."planId";
  IF st IS NOT NULL AND st <> 'DRAFT' THEN RAISE EXCEPTION 'Merkmale aktivierter Prüfpläne sind unveränderlich'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InspectionCharacteristic_guard" BEFORE UPDATE OR DELETE ON "InspectionCharacteristic" FOR EACH ROW EXECUTE FUNCTION inspection_characteristic_guard();

CREATE OR REPLACE FUNCTION inspection_plan_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Aktivierte Prüfpläne dürfen nicht gelöscht werden'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'ARCHIVED' THEN RAISE EXCEPTION 'Archivierte Prüfpläne sind unveränderlich'; END IF;
  IF OLD.status = 'ACTIVE' AND (NEW.status <> 'ARCHIVED' OR NEW."itemId" <> OLD."itemId") THEN RAISE EXCEPTION 'Aktivierte Prüfpläne sind gesperrt (nur archivieren)'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InspectionPlan_guard" BEFORE UPDATE OR DELETE ON "InspectionPlan" FOR EACH ROW EXECUTE FUNCTION inspection_plan_guard();

-- Prüflos: nach dem Entscheid unveränderlich (OPEN → ACCEPTED/REJECTED einmalig); Ergebnisse nur solange OPEN
CREATE OR REPLACE FUNCTION inspection_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Prüflose dürfen nicht gelöscht werden'; END IF;
  IF OLD.status <> 'OPEN' THEN RAISE EXCEPTION 'Entschiedene Prüflose sind unveränderlich'; END IF;
  IF NEW."itemId" <> OLD."itemId" OR NEW."planId" <> OLD."planId" OR NEW.quantity <> OLD.quantity THEN RAISE EXCEPTION 'Prüfgegenstand lässt sich nicht ändern'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Inspection_guard" BEFORE UPDATE OR DELETE ON "Inspection" FOR EACH ROW EXECUTE FUNCTION inspection_guard();

CREATE OR REPLACE FUNCTION inspection_result_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM "Inspection" WHERE id = OLD."inspectionId";
  IF st IS NOT NULL AND st <> 'OPEN' THEN RAISE EXCEPTION 'Ergebnisse entschiedener Prüflose sind unveränderlich'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "InspectionResult_guard" BEFORE UPDATE OR DELETE ON "InspectionResult" FOR EACH ROW EXECUTE FUNCTION inspection_result_guard();

-- Abweichungen: geschlossene sind unveränderlich; nie löschen
CREATE OR REPLACE FUNCTION nonconformance_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Abweichungen dürfen nicht gelöscht werden'; END IF;
  IF OLD.status = 'CLOSED' THEN RAISE EXCEPTION 'Geschlossene Abweichungen sind unveränderlich'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "NonConformance_guard" BEFORE UPDATE OR DELETE ON "NonConformance" FOR EACH ROW EXECUTE FUNCTION nonconformance_guard();

-- ── Instandhaltung ──
ALTER TABLE "MaintenancePlan" ADD CONSTRAINT "MaintenancePlan_check" CHECK ("intervalUnit" IN ('DAYS', 'MONTHS') AND "intervalValue" > 0);
ALTER TABLE "MaintenanceOrder" ADD CONSTRAINT "MaintenanceOrder_check" CHECK (
  "kind" IN ('PREVENTIVE', 'CORRECTIVE') AND "priority" IN ('LOW', 'NORMAL', 'HIGH', 'URGENT') AND "status" IN ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')
);
-- Je Wartungsplan höchstens ein nicht abgeschlossener vorbeugender Auftrag
CREATE UNIQUE INDEX "MaintenanceOrder_one_open_per_plan" ON "MaintenanceOrder"("planId") WHERE "planId" IS NOT NULL AND "status" IN ('OPEN', 'IN_PROGRESS');

CREATE OR REPLACE FUNCTION maintenance_order_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Instandhaltungsaufträge dürfen nicht gelöscht werden'; END IF;
  IF OLD.status IN ('DONE', 'CANCELLED') THEN RAISE EXCEPTION 'Abgeschlossene Instandhaltungsaufträge sind unveränderlich'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaintenanceOrder_guard" BEFORE UPDATE OR DELETE ON "MaintenanceOrder" FOR EACH ROW EXECUTE FUNCTION maintenance_order_guard();
CREATE TRIGGER "MaintenancePart_guard" BEFORE UPDATE OR DELETE ON "MaintenancePart" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
