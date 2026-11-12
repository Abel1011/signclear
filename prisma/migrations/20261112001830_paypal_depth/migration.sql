-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "payeeMerchantId" TEXT;

-- AlterTable
ALTER TABLE "Preparer" ADD COLUMN "paypalMerchantId" TEXT;
ALTER TABLE "Preparer" ADD COLUMN "paypalOnboardedAt" DATETIME;
ALTER TABLE "Preparer" ADD COLUMN "paypalPermissions" TEXT;
ALTER TABLE "Preparer" ADD COLUMN "paypalTrackingId" TEXT;

-- CreateTable
CREATE TABLE "FeeLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "platformFee" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'AUTHORIZED',
    "captureId" TEXT,
    "capturedAt" DATETIME,
    "refundId" TEXT,
    "refundedAmount" INTEGER NOT NULL DEFAULT 0,
    "lastDebugId" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeeLine_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "disputeId" TEXT NOT NULL,
    "caseId" TEXT,
    "captureId" TEXT,
    "reason" TEXT,
    "status" TEXT,
    "stage" TEXT,
    "amount" INTEGER,
    "sellerResponseDue" DATETIME,
    "links" TEXT NOT NULL DEFAULT '[]',
    "outcome" TEXT,
    "evidenceSubmittedAt" DATETIME,
    "claimAcceptedAt" DATETIME,
    "lastDebugId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Dispute_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Case" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "preparerId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "clientLang" TEXT NOT NULL DEFAULT 'es',
    "fee" INTEGER NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'CASE_CREATED',
    "version" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseUntil" DATETIME,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "demoSession" TEXT,
    "scenario" TEXT,
    "clockOffsetMs" INTEGER NOT NULL DEFAULT 0,
    "seasonOpen" DATETIME,
    "approvedAt" DATETIME,
    "ackDeadline" DATETIME,
    "transmittedAt" DATETIME,
    "submissionId" TEXT,
    "ackReceivedAt" DATETIME,
    "capturedAt" DATETIME,
    "refundDeadline" DATETIME,
    "refundReportedAmount" INTEGER,
    "preparerVerdict" TEXT,
    "clientConfirmedRefund" BOOLEAN NOT NULL DEFAULT false,
    "r15Flag" BOOLEAN NOT NULL DEFAULT false,
    "stateFee" INTEGER NOT NULL DEFAULT 0,
    "stateSubmissionId" TEXT,
    "stateAckReceivedAt" DATETIME,
    "clientToken" TEXT NOT NULL,
    "preparerToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Case_preparerId_fkey" FOREIGN KEY ("preparerId") REFERENCES "Preparer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Case" ("ackDeadline", "ackReceivedAt", "approvedAt", "capturedAt", "clientConfirmedRefund", "clientLang", "clientName", "clientToken", "clockOffsetMs", "createdAt", "demoSession", "fee", "id", "isDemo", "leaseOwner", "leaseUntil", "preparerId", "preparerToken", "preparerVerdict", "r15Flag", "refundDeadline", "refundReportedAmount", "scenario", "seasonOpen", "state", "submissionId", "transmittedAt", "updatedAt", "version") SELECT "ackDeadline", "ackReceivedAt", "approvedAt", "capturedAt", "clientConfirmedRefund", "clientLang", "clientName", "clientToken", "clockOffsetMs", "createdAt", "demoSession", "fee", "id", "isDemo", "leaseOwner", "leaseUntil", "preparerId", "preparerToken", "preparerVerdict", "r15Flag", "refundDeadline", "refundReportedAmount", "scenario", "seasonOpen", "state", "submissionId", "transmittedAt", "updatedAt", "version" FROM "Case";
DROP TABLE "Case";
ALTER TABLE "new_Case" RENAME TO "Case";
CREATE UNIQUE INDEX "Case_clientToken_key" ON "Case"("clientToken");
CREATE UNIQUE INDEX "Case_preparerToken_key" ON "Case"("preparerToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "FeeLine_captureId_key" ON "FeeLine"("captureId");

-- CreateIndex
CREATE UNIQUE INDEX "FeeLine_caseId_kind_key" ON "FeeLine"("caseId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_disputeId_key" ON "Dispute"("disputeId");
