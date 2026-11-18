-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "tracking" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "valuationMethod" TEXT NOT NULL DEFAULT 'AVG';

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "locationId" TEXT,
ADD COLUMN     "serial" TEXT,
ADD COLUMN     "transferId" TEXT,
ADD COLUMN     "unitCost" DECIMAL(19,6);

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "expiresOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_organizationId_code_key" ON "StockLocation"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StockBatch_itemId_number_key" ON "StockBatch"("itemId", "number");

-- CreateIndex
CREATE INDEX "StockMovement_organizationId_itemId_locationId_batchId_idx" ON "StockMovement"("organizationId", "itemId", "locationId", "batchId");

-- CreateIndex
CREATE INDEX "StockMovement_organizationId_itemId_serial_idx" ON "StockMovement"("organizationId", "itemId", "serial");

-- AddForeignKey
ALTER TABLE "StockBatch" ADD CONSTRAINT "StockBatch_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "Item" ADD CONSTRAINT "Item_tracking_check" CHECK ("tracking" IN ('NONE', 'BATCH', 'SERIAL'));
ALTER TABLE "Item" ADD CONSTRAINT "Item_valuationMethod_check" CHECK ("valuationMethod" IN ('AVG', 'FIFO'));
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_serial_qty_check" CHECK ("serial" IS NULL OR abs("quantity") = 1);
