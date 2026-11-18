-- CreateEnum
CREATE TYPE "AbsenceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "absenceRequestId" TEXT,
ALTER COLUMN "requestId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "jobTitle" TEXT,
    "departmentId" TEXT,
    "managerId" TEXT,
    "userId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeSensitive" (
    "employeeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "birthDate" DATE,
    "addressLine" TEXT,
    "phone" TEXT,
    "emergencyContact" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeSensitive_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "Employment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "validTo" DATE,
    "contractType" TEXT NOT NULL,
    "weeklyHours" DECIMAL(5,2) NOT NULL,
    "costCenterId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbsenceType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deductsLeave" BOOLEAN NOT NULL DEFAULT false,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AbsenceType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbsenceRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "status" "AbsenceStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "policyVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AbsenceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveBalanceEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "days" DECIMAL(6,2) NOT NULL,
    "absenceRequestId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveBalanceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employee_organizationId_managerId_idx" ON "Employee"("organizationId", "managerId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_organizationId_number_key" ON "Employee"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_organizationId_userId_key" ON "Employee"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "Employment_organizationId_employeeId_validFrom_idx" ON "Employment"("organizationId", "employeeId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "AbsenceType_organizationId_key_key" ON "AbsenceType"("organizationId", "key");

-- CreateIndex
CREATE INDEX "AbsenceRequest_organizationId_status_idx" ON "AbsenceRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AbsenceRequest_organizationId_employeeId_startDate_idx" ON "AbsenceRequest"("organizationId", "employeeId", "startDate");

-- CreateIndex
CREATE INDEX "LeaveBalanceEntry_organizationId_employeeId_year_idx" ON "LeaveBalanceEntry"("organizationId", "employeeId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_absenceRequestId_sequence_key" ON "Approval"("absenceRequestId", "sequence");

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_absenceRequestId_fkey" FOREIGN KEY ("absenceRequestId") REFERENCES "AbsenceRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeSensitive" ADD CONSTRAINT "EmployeeSensitive_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employment" ADD CONSTRAINT "Employment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employment" ADD CONSTRAINT "Employment_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbsenceType" ADD CONSTRAINT "AbsenceType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbsenceRequest" ADD CONSTRAINT "AbsenceRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbsenceRequest" ADD CONSTRAINT "AbsenceRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbsenceRequest" ADD CONSTRAINT "AbsenceRequest_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AbsenceType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalanceEntry" ADD CONSTRAINT "LeaveBalanceEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveBalanceEntry" ADD CONSTRAINT "LeaveBalanceEntry_absenceRequestId_fkey" FOREIGN KEY ("absenceRequestId") REFERENCES "AbsenceRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Eine Freigabe gehört zu genau einem Vorgang (Bestellanforderung ODER Abwesenheitsantrag)
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_exactly_one_subject"
  CHECK ((("requestId" IS NOT NULL)::int + ("absenceRequestId" IS NOT NULL)::int) = 1);

-- Urlaubskonto ist ein Journal: keine Änderungen, kein Löschen.
-- Ausnahme nur in einer Transaktion mit gesetztem app.allow_journal_delete (z. B. Aufräumen von Testdaten, DSGVO-Löschung durch Admin-Prozess).
CREATE OR REPLACE FUNCTION leave_journal_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'LeaveBalanceEntry ist append-only (UPDATE nicht erlaubt)';
  END IF;
  IF TG_OP = 'DELETE' AND coalesce(current_setting('app.allow_journal_delete', true), '') <> 'on' THEN
    RAISE EXCEPTION 'LeaveBalanceEntry ist append-only (DELETE nicht erlaubt)';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveBalanceEntry_guard"
  BEFORE UPDATE OR DELETE ON "LeaveBalanceEntry"
  FOR EACH ROW EXECUTE FUNCTION leave_journal_guard();
