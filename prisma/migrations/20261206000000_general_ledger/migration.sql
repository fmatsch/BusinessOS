-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "kind" TEXT;

-- AlterTable
ALTER TABLE "TaxCode" ADD COLUMN     "uvaBaseCode" TEXT,
ADD COLUMN     "uvaTaxCode" TEXT,
ADD COLUMN     "vatAccountId" TEXT;

-- CreateTable
CREATE TABLE "GlSettings" (
    "organizationId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "bankAccountId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "AccountingPeriod" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "note" TEXT,

    CONSTRAINT "AccountingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "entryDate" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceId" TEXT,
    "reversesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "costCenterId" TEXT,
    "taxCodeId" TEXT,
    "taxRole" TEXT,
    "text" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingPeriod_organizationId_year_month_key" ON "AccountingPeriod"("organizationId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversesId_key" ON "JournalEntry"("reversesId");

-- CreateIndex
CREATE INDEX "JournalEntry_organizationId_entryDate_idx" ON "JournalEntry"("organizationId", "entryDate");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_organizationId_number_key" ON "JournalEntry"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_organizationId_source_sourceId_key" ON "JournalEntry"("organizationId", "source", "sourceId");

-- CreateIndex
CREATE INDEX "JournalLine_accountId_idx" ON "JournalLine"("accountId");

-- CreateIndex
CREATE INDEX "JournalLine_entryId_idx" ON "JournalLine"("entryId");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hauptbuch: Wertebereiche je Zeile
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_one_side" CHECK ("debit" >= 0 AND "credit" >= 0 AND ("debit" = 0 OR "credit" = 0) AND ("debit" + "credit") > 0);

-- Buchungssätze und -zeilen sind append-only (DELETE nur mit app.allow_journal_delete, z. B. Aufräumen von Testdaten)
CREATE TRIGGER "JournalEntry_guard" BEFORE UPDATE OR DELETE ON "JournalEntry" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
CREATE TRIGGER "JournalLine_guard" BEFORE UPDATE OR DELETE ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();

-- Soll = Haben je Buchungssatz, geprüft am Ende der Transaktion (nach dem Einfügen aller Zeilen)
CREATE OR REPLACE FUNCTION journal_entry_balanced() RETURNS trigger AS $$
DECLARE diff numeric;
BEGIN
  SELECT COALESCE(SUM("debit"), 0) - COALESCE(SUM("credit"), 0) INTO diff FROM "JournalLine" WHERE "entryId" = NEW."entryId";
  IF diff <> 0 THEN
    RAISE EXCEPTION 'Buchungssatz % ist nicht ausgeglichen (Differenz %)', NEW."entryId", diff USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "JournalLine_balanced" AFTER INSERT ON "JournalLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();
