-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "expenseReportId" TEXT;

-- CreateTable
CREATE TABLE "ExpenseSettings" (
    "organizationId" TEXT NOT NULL,
    "mileageRate" DECIMAL(9,4) NOT NULL DEFAULT 0.50,

    CONSTRAINT "ExpenseSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "ExpenseReport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "number" TEXT,
    "title" TEXT NOT NULL,
    "tripFrom" DATE,
    "tripTo" DATE,
    "costCenterId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "totalAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "policyVersion" INTEGER,
    "note" TEXT,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "paidOn" DATE,
    "paidById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseLine" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(9,2),
    "amount" DECIMAL(19,4) NOT NULL,
    "receiptFileId" TEXT,

    CONSTRAINT "ExpenseLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseReport_organizationId_employeeId_idx" ON "ExpenseReport"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "ExpenseReport_organizationId_status_idx" ON "ExpenseReport"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseReport_organizationId_number_key" ON "ExpenseReport"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_expenseReportId_sequence_key" ON "Approval"("expenseReportId", "sequence");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_expenseReportId_fkey" FOREIGN KEY ("expenseReportId") REFERENCES "ExpenseReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseLine" ADD CONSTRAINT "ExpenseLine_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ExpenseReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Eine Freigabe gehört zu genau einem Vorgang (Bestellanforderung, Abwesenheitsantrag, Angebot ODER Spesenabrechnung)
ALTER TABLE "Approval" DROP CONSTRAINT "Approval_exactly_one_subject";
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_exactly_one_subject"
  CHECK ((("requestId" IS NOT NULL)::int + ("absenceRequestId" IS NOT NULL)::int + ("quoteId" IS NOT NULL)::int + ("expenseReportId" IS NOT NULL)::int) = 1);
