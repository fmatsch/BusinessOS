-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customerId" TEXT,
    "costCenterId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "hourlyRate" DECIMAL(19,2),
    "budgetHours" DECIMAL(9,2),
    "startsOn" DATE,
    "endsOn" DATE,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectTime" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "note" TEXT,
    "kind" TEXT NOT NULL,
    "reversesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectTime_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectBilling" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "upTo" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "hourlyRate" DECIMAL(19,2) NOT NULL,
    "netAmount" DECIMAL(19,4) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectBilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectBillingItem" (
    "id" TEXT NOT NULL,
    "billingId" TEXT NOT NULL,
    "timeId" TEXT NOT NULL,

    CONSTRAINT "ProjectBillingItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_organizationId_status_idx" ON "Project"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_number_key" ON "Project"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectTime_reversesId_key" ON "ProjectTime"("reversesId");

-- CreateIndex
CREATE INDEX "ProjectTime_organizationId_projectId_workDate_idx" ON "ProjectTime"("organizationId", "projectId", "workDate");

-- CreateIndex
CREATE INDEX "ProjectTime_organizationId_employeeId_workDate_idx" ON "ProjectTime"("organizationId", "employeeId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBilling_invoiceId_key" ON "ProjectBilling"("invoiceId");

-- CreateIndex
CREATE INDEX "ProjectBilling_organizationId_projectId_idx" ON "ProjectBilling"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectBillingItem_timeId_key" ON "ProjectBillingItem"("timeId");

-- AddForeignKey
ALTER TABLE "ProjectTime" ADD CONSTRAINT "ProjectTime_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectTime" ADD CONSTRAINT "ProjectTime_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "ProjectTime"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBilling" ADD CONSTRAINT "ProjectBilling_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBillingItem" ADD CONSTRAINT "ProjectBillingItem_billingId_fkey" FOREIGN KEY ("billingId") REFERENCES "ProjectBilling"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectBillingItem" ADD CONSTRAINT "ProjectBillingItem_timeId_fkey" FOREIGN KEY ("timeId") REFERENCES "ProjectTime"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Projektzeiten, Abrechnungsläufe und -positionen sind append-only (DELETE nur mit app.allow_journal_delete, z. B. Aufräumen von Testdaten)
CREATE TRIGGER "ProjectTime_guard" BEFORE UPDATE OR DELETE ON "ProjectTime" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
CREATE TRIGGER "ProjectBilling_guard" BEFORE UPDATE OR DELETE ON "ProjectBilling" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
CREATE TRIGGER "ProjectBillingItem_guard" BEFORE UPDATE OR DELETE ON "ProjectBillingItem" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
