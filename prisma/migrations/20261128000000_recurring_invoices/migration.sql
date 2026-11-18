-- AlterTable
ALTER TABLE "CustomerInvoice" ADD COLUMN     "recurringDate" DATE,
ADD COLUMN     "recurringId" TEXT;

-- CreateTable
CREATE TABLE "RecurringInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "anchorDay" INTEGER NOT NULL,
    "nextRunOn" DATE NOT NULL,
    "endsOn" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "lastRunOn" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurringInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurringInvoiceLine" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitPrice" DECIMAL(19,4) NOT NULL,
    "taxCodeId" TEXT NOT NULL,
    "revenueAccountId" TEXT,
    "costCenterId" TEXT,

    CONSTRAINT "RecurringInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecurringInvoice_organizationId_active_nextRunOn_idx" ON "RecurringInvoice"("organizationId", "active", "nextRunOn");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoice_recurringId_recurringDate_key" ON "CustomerInvoice"("recurringId", "recurringDate");

-- AddForeignKey
ALTER TABLE "RecurringInvoice" ADD CONSTRAINT "RecurringInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurringInvoiceLine" ADD CONSTRAINT "RecurringInvoiceLine_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "RecurringInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
