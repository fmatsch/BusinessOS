-- CreateEnum
CREATE TYPE "SwapStatus" AS ENUM ('PENDING_PEER', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'Europe/Vienna',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Qualification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeQualification" (
    "employeeId" TEXT NOT NULL,
    "qualificationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "EmployeeQualification_pkey" PRIMARY KEY ("employeeId","qualificationId")
);

-- CreateTable
CREATE TABLE "ShiftTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "requiredCount" INTEGER NOT NULL DEFAULT 1,
    "qualificationId" TEXT,

    CONSTRAINT "ShiftTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Roster" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "dirty" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Roster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "localDate" DATE NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "requiredCount" INTEGER NOT NULL DEFAULT 1,
    "qualificationId" TEXT,
    "label" TEXT,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RosterVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishedShift" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "shiftId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "breakMinutes" INTEGER NOT NULL,
    "siteName" TEXT NOT NULL,
    "label" TEXT,

    CONSTRAINT "PublishedShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftSwapRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rosterId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "fromEmployeeId" TEXT NOT NULL,
    "toEmployeeId" TEXT NOT NULL,
    "status" "SwapStatus" NOT NULL DEFAULT 'PENDING_PEER',
    "note" TEXT,
    "decidedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftSwapRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RosterRules" (
    "organizationId" TEXT NOT NULL,
    "restDailyMinutes" INTEGER NOT NULL DEFAULT 660,
    "maxDailyMinutes" INTEGER NOT NULL DEFAULT 720,
    "maxWeeklyMinutes" INTEGER NOT NULL DEFAULT 3600,
    "breakAfterMinutes" INTEGER NOT NULL DEFAULT 360,
    "minBreakMinutes" INTEGER NOT NULL DEFAULT 30,
    "weeklyRestMinutes" INTEGER NOT NULL DEFAULT 2160,

    CONSTRAINT "RosterRules_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Site_organizationId_name_key" ON "Site"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Qualification_organizationId_name_key" ON "Qualification"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftTemplate_organizationId_name_key" ON "ShiftTemplate"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Roster_organizationId_siteId_startDate_idx" ON "Roster"("organizationId", "siteId", "startDate");

-- CreateIndex
CREATE INDEX "Shift_organizationId_rosterId_startAt_idx" ON "Shift"("organizationId", "rosterId", "startAt");

-- CreateIndex
CREATE INDEX "ShiftAssignment_organizationId_employeeId_idx" ON "ShiftAssignment"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftAssignment_shiftId_employeeId_key" ON "ShiftAssignment"("shiftId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "RosterVersion_rosterId_version_key" ON "RosterVersion"("rosterId", "version");

-- CreateIndex
CREATE INDEX "PublishedShift_organizationId_employeeId_startAt_idx" ON "PublishedShift"("organizationId", "employeeId", "startAt");

-- CreateIndex
CREATE INDEX "PublishedShift_rosterId_idx" ON "PublishedShift"("rosterId");

-- CreateIndex
CREATE INDEX "ShiftSwapRequest_organizationId_status_idx" ON "ShiftSwapRequest"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeQualification" ADD CONSTRAINT "EmployeeQualification_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftTemplate" ADD CONSTRAINT "ShiftTemplate_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Roster" ADD CONSTRAINT "Roster_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "Roster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_qualificationId_fkey" FOREIGN KEY ("qualificationId") REFERENCES "Qualification"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RosterVersion" ADD CONSTRAINT "RosterVersion_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "Roster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "Roster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftSwapRequest" ADD CONSTRAINT "ShiftSwapRequest_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Veröffentlichte Planversionen sind unveränderlich (Ausnahme nur mit app.allow_journal_delete, z. B. Aufräumen von Testdaten)
CREATE OR REPLACE FUNCTION roster_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RosterVersion ist unveränderlich (UPDATE nicht erlaubt)';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.allow_journal_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'RosterVersion ist unveränderlich (DELETE nicht erlaubt)';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RosterVersion_guard"
  BEFORE UPDATE OR DELETE ON "RosterVersion"
  FOR EACH ROW EXECUTE FUNCTION roster_version_guard();
