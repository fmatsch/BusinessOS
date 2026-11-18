-- DropIndex
DROP INDEX "OutboxEvent_processedAt_createdAt_idx";

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "label" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "requiredPermission" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "href" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'info';

-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "PurchaseRequest" ADD COLUMN     "policyVersion" INTEGER;

-- CreateTable
CREATE TABLE "ApprovalPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "steps" JSONB NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalPolicy_organizationId_subjectType_version_key" ON "ApprovalPolicy"("organizationId", "subjectType", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_processedAt_failedAt_nextAttemptAt_idx" ON "OutboxEvent"("processedAt", "failedAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "ApprovalPolicy" ADD CONSTRAINT "ApprovalPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: bestehende Freigabeschritte erhalten Berechtigung und Bezeichnung der bisherigen festen Regel
UPDATE "Approval" SET "requiredPermission" = 'procurement.request.approve', "label" = 'Führungskraft' WHERE "stepKey" = 'MANAGER';
UPDATE "Approval" SET "requiredPermission" = 'procurement.request.approve_finance', "label" = 'Finanzen' WHERE "stepKey" = 'FINANCE';
ALTER TABLE "Approval" ALTER COLUMN "requiredPermission" DROP DEFAULT;
