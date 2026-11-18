-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "varianceAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "varianceAcceptedById" TEXT,
ADD COLUMN     "varianceReason" TEXT;

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "receivedOn" DATE NOT NULL,
    "note" TEXT,
    "reversesId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "requestLineId" TEXT NOT NULL,
    "quantity" DECIMAL(19,4) NOT NULL,

    CONSTRAINT "GoodsReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_reversesId_key" ON "GoodsReceipt"("reversesId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_organizationId_orderId_idx" ON "GoodsReceipt"("organizationId", "orderId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_receiptId_idx" ON "GoodsReceiptLine"("receiptId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_requestLineId_idx" ON "GoodsReceiptLine"("requestLineId");

-- AddForeignKey
ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Wareneingänge sind append-only (Korrektur nur per Gegenbuchung; DELETE nur mit app.allow_journal_delete, z. B. Aufräumen von Testdaten)
CREATE TRIGGER "GoodsReceipt_guard" BEFORE UPDATE OR DELETE ON "GoodsReceipt" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
CREATE TRIGGER "GoodsReceiptLine_guard" BEFORE UPDATE OR DELETE ON "GoodsReceiptLine" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();
