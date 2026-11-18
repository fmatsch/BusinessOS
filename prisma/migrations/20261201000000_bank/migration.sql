-- CreateTable
CREATE TABLE "BankImport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "newCount" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "bookingDate" DATE NOT NULL,
    "amount" DECIMAL(19,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "counterpartyName" TEXT,
    "counterpartyIban" TEXT,
    "reference" TEXT NOT NULL DEFAULT '',
    "endToEndId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "matchKind" TEXT,
    "matchedId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankImport_organizationId_sha256_key" ON "BankImport"("organizationId", "sha256");

-- CreateIndex
CREATE INDEX "BankLine_organizationId_status_bookingDate_idx" ON "BankLine"("organizationId", "status", "bookingDate");

-- CreateIndex
CREATE UNIQUE INDEX "BankLine_organizationId_dedupeKey_key" ON "BankLine"("organizationId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "BankLine" ADD CONSTRAINT "BankLine_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

