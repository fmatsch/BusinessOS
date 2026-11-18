-- AlterTable
ALTER TABLE "AccountingProfile" ADD COLUMN     "matchToleranceAmount" DECIMAL(19,2) NOT NULL DEFAULT 5,
ADD COLUMN     "matchTolerancePercent" DECIMAL(5,2) NOT NULL DEFAULT 2;
