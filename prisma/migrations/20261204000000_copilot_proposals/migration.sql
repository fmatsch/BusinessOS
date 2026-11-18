-- CreateTable
CREATE TABLE "CopilotProposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resultMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "CopilotProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CopilotProposal_organizationId_userId_status_idx" ON "CopilotProposal"("organizationId", "userId", "status");

