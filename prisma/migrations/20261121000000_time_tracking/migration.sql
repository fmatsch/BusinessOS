-- CreateEnum
CREATE TYPE "TimeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PeriodStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED');

-- CreateTable
CREATE TABLE "TimeClock" (
    "employeeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "costCenterId" TEXT,
    "breakStartedAt" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TimeClock_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "localDate" DATE NOT NULL,
    "costCenterId" TEXT,
    "source" TEXT NOT NULL,
    "reason" TEXT,
    "replacesId" TEXT,
    "reversesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntryRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "targetEntryId" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "breakMinutes" INTEGER,
    "costCenterId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "TimeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimesheetPeriod" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "PeriodStatus" NOT NULL DEFAULT 'OPEN',
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "summary" JSONB,
    "reopenCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TimesheetPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeAccountEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "periodId" TEXT,
    "year" INTEGER,
    "month" INTEGER,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeAccountEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayCodeRule" (
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "percent" DECIMAL(6,2) NOT NULL,

    CONSTRAINT "PayCodeRule_pkey" PRIMARY KEY ("organizationId","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "TimeEntry_reversesId_key" ON "TimeEntry"("reversesId");

-- CreateIndex
CREATE INDEX "TimeEntry_organizationId_employeeId_startAt_idx" ON "TimeEntry"("organizationId", "employeeId", "startAt");

-- CreateIndex
CREATE INDEX "TimeEntryRequest_organizationId_status_idx" ON "TimeEntryRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "TimeEntryRequest_organizationId_employeeId_idx" ON "TimeEntryRequest"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "TimesheetPeriod_organizationId_employeeId_year_month_key" ON "TimesheetPeriod"("organizationId", "employeeId", "year", "month");

-- CreateIndex
CREATE INDEX "TimeAccountEntry_organizationId_employeeId_idx" ON "TimeAccountEntry"("organizationId", "employeeId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "TimeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Zeitbuchungen und Zeitkonto sind Journale: kein UPDATE, DELETE nur mit app.allow_journal_delete (z. B. Aufräumen von Testdaten)
CREATE OR REPLACE FUNCTION time_journal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% ist append-only (UPDATE nicht erlaubt)', TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.allow_journal_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION '% ist append-only (DELETE nicht erlaubt)', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TimeEntry_guard" BEFORE UPDATE OR DELETE ON "TimeEntry" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
CREATE TRIGGER "TimeAccountEntry_guard" BEFORE UPDATE OR DELETE ON "TimeAccountEntry" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
