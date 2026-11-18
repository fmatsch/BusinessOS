-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "expenseAccountId" TEXT,
ADD COLUMN     "payableAccountId" TEXT,
ADD COLUMN     "uid" TEXT;

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxCode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "direction" TEXT NOT NULL,
    "bmdCode" TEXT,
    "datevKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TaxCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "street" TEXT,
    "zip" TEXT,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'AT',
    "uid" TEXT,
    "paymentTermsDays" INTEGER NOT NULL DEFAULT 14,
    "receivableAccountId" TEXT,
    "revenueAccountId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceFile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE,
    "kind" TEXT NOT NULL DEFAULT 'INVOICE',
    "creditsId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "voucherNumber" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "netTotal" DECIMAL(19,4) NOT NULL,
    "taxTotal" DECIMAL(19,4) NOT NULL,
    "grossTotal" DECIMAL(19,4) NOT NULL,
    "purchaseOrderId" TEXT,
    "fileId" TEXT,
    "paidOn" DATE,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "netAmount" DECIMAL(19,4) NOT NULL,
    "taxCodeId" TEXT NOT NULL,
    "expenseAccountId" TEXT NOT NULL,
    "costCenterId" TEXT,

    CONSTRAINT "SupplierInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerInvoice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "number" TEXT,
    "invoiceDate" DATE NOT NULL,
    "dueDate" DATE,
    "kind" TEXT NOT NULL DEFAULT 'INVOICE',
    "creditsId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "netTotal" DECIMAL(19,4) NOT NULL,
    "taxTotal" DECIMAL(19,4) NOT NULL,
    "grossTotal" DECIMAL(19,4) NOT NULL,
    "paidOn" DATE,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "issuedById" TEXT,
    "issuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,
    "unitPrice" DECIMAL(19,4) NOT NULL,
    "netAmount" DECIMAL(19,4) NOT NULL,
    "taxCodeId" TEXT NOT NULL,
    "revenueAccountId" TEXT NOT NULL,
    "costCenterId" TEXT,

    CONSTRAINT "CustomerInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingProfile" (
    "organizationId" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'BMD',
    "advisorNumber" TEXT,
    "clientNumber" TEXT,
    "accountLength" INTEGER NOT NULL DEFAULT 4,
    "fiscalYearStartMonth" INTEGER NOT NULL DEFAULT 1,
    "symbolIn" TEXT NOT NULL DEFAULT 'ER',
    "symbolOut" TEXT NOT NULL DEFAULT 'AR',
    "dictationCode" TEXT NOT NULL DEFAULT '',
    "includeFiles" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AccountingProfile_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "AccountingExport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "packageName" TEXT,
    "packageData" BYTEA,
    "packageHash" TEXT,
    "profile" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "voucherCount" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "fromDate" DATE,
    "toDate" DATE,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountingExportItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "exportId" TEXT NOT NULL,
    "voucherType" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,

    CONSTRAINT "AccountingExportItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_organizationId_number_key" ON "Account"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TaxCode_organizationId_key_key" ON "TaxCode"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_organizationId_number_key" ON "Customer"("organizationId", "number");

-- CreateIndex
CREATE INDEX "SupplierInvoice_organizationId_status_idx" ON "SupplierInvoice"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_organizationId_voucherNumber_key" ON "SupplierInvoice"("organizationId", "voucherNumber");

-- CreateIndex
CREATE INDEX "CustomerInvoice_organizationId_status_idx" ON "CustomerInvoice"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoice_organizationId_number_key" ON "CustomerInvoice"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExport_organizationId_version_key" ON "AccountingExport"("organizationId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExportItem_organizationId_voucherType_voucherId_key" ON "AccountingExportItem"("organizationId", "voucherType", "voucherId");

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoiceLine" ADD CONSTRAINT "SupplierInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SupplierInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInvoice" ADD CONSTRAINT "CustomerInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInvoiceLine" ADD CONSTRAINT "CustomerInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CustomerInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountingExportItem" ADD CONSTRAINT "AccountingExportItem_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "AccountingExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Rechnungsnummer des Lieferanten ist je Lieferant eindeutig, solange der Beleg nicht storniert ist (Teil-Index)
CREATE UNIQUE INDEX "SupplierInvoice_supplier_number_active"
  ON "SupplierInvoice" ("organizationId", "supplierId", "invoiceNumber") WHERE "status" <> 'CANCELLED';

-- Exportläufe und die Zuordnung exportierter Belege sind unveränderlich (Ausnahme nur mit app.allow_journal_delete, z. B. Aufräumen von Testdaten)
CREATE TRIGGER "AccountingExport_guard" BEFORE UPDATE OR DELETE ON "AccountingExport" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
CREATE TRIGGER "AccountingExportItem_guard" BEFORE UPDATE OR DELETE ON "AccountingExportItem" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
