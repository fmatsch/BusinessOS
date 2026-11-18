-- AlterTable
ALTER TABLE "CustomerInvoice" ADD COLUMN     "issuerSnapshot" JSONB;

-- CreateTable
CREATE TABLE "IssuerProfile" (
    "organizationId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "street" TEXT,
    "zip" TEXT,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'AT',
    "uid" TEXT,
    "companyRegister" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "bankName" TEXT,
    "email" TEXT,
    "phone" TEXT,

    CONSTRAINT "IssuerProfile_pkey" PRIMARY KEY ("organizationId")
);
