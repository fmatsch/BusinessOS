-- CreateTable
CREATE TABLE "PayrollProfile" (
    "organizationId" TEXT NOT NULL,
    "delimiter" TEXT NOT NULL DEFAULT ';',
    "decimalSeparator" TEXT NOT NULL DEFAULT ',',
    "includeHeader" BOOLEAN NOT NULL DEFAULT true,
    "encoding" TEXT NOT NULL DEFAULT 'utf8-bom',
    "unit" TEXT NOT NULL DEFAULT 'HOURS',
    "includeSurcharge" BOOLEAN NOT NULL DEFAULT true,
    "codes" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollProfile_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "PayrollExport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "profile" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "excluded" JSONB NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollExportLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "exportId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "wageType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "percent" DECIMAL(6,2),

    CONSTRAINT "PayrollExportLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollExport_organizationId_year_month_version_key" ON "PayrollExport"("organizationId", "year", "month", "version");

-- CreateIndex
CREATE INDEX "PayrollExportLine_organizationId_employeeId_idx" ON "PayrollExportLine"("organizationId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollExportLine_exportId_idx" ON "PayrollExportLine"("exportId");

-- AddForeignKey
ALTER TABLE "PayrollExportLine" ADD CONSTRAINT "PayrollExportLine_exportId_fkey" FOREIGN KEY ("exportId") REFERENCES "PayrollExport"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Exportläufe und -zeilen sind unveränderlich (Ausnahme nur mit app.allow_journal_delete, z. B. Aufräumen von Testdaten)
CREATE TRIGGER "PayrollExport_guard" BEFORE UPDATE OR DELETE ON "PayrollExport" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
CREATE TRIGGER "PayrollExportLine_guard" BEFORE UPDATE OR DELETE ON "PayrollExportLine" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
