-- CreateTable
CREATE TABLE "DunningNotice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "issuedOn" DATE NOT NULL,
    "openAmount" DECIMAL(19,4) NOT NULL,
    "feeAmount" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "payByDate" DATE NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DunningNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DunningNotice_organizationId_invoiceId_idx" ON "DunningNotice"("organizationId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "DunningNotice_organizationId_invoiceId_level_key" ON "DunningNotice"("organizationId", "invoiceId", "level");

-- Mahnungen sind append-only (DELETE nur mit app.allow_journal_delete, z. B. Aufräumen von Testdaten)
CREATE TRIGGER "DunningNotice_guard" BEFORE UPDATE OR DELETE ON "DunningNotice" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
