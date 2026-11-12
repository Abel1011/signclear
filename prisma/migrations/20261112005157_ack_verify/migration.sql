-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "preparerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "caseId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ReaderCache" (
    "sha256" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "paypalSim" BOOLEAN NOT NULL DEFAULT false,
    "clientToken" TEXT NOT NULL,
    "preparerToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Case_preparerId_fkey" FOREIGN KEY ("preparerId") REFERENCES "Preparer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Case" ("ackDeadline", "ackReceivedAt", "approvedAt", "capturedAt", "clientConfirmedRefund", "clientLang", "clientName", "clientToken", "clockOffsetMs", "createdAt", "demoSession", "fee", "id", "isDemo", "leaseOwner", "leaseUntil", "preparerId", "preparerToken", "preparerVerdict", "r15Flag", "refundDeadline", "refundReportedAmount", "scenario", "seasonOpen", "state", "stateAckReceivedAt", "stateFee", "stateSubmissionId", "submissionId", "transmittedAt", "updatedAt", "version") SELECT "ackDeadline", "ackReceivedAt", "approvedAt", "capturedAt", "clientConfirmedRefund", "clientLang", "clientName", "clientToken", "clockOffsetMs", "createdAt", "demoSession", "fee", "id", "isDemo", "leaseOwner", "leaseUntil", "preparerId", "preparerToken", "preparerVerdict", "r15Flag", "refundDeadline", "refundReportedAmount", "scenario", "seasonOpen", "state", "stateAckReceivedAt", "stateFee", "stateSubmissionId", "submissionId", "transmittedAt", "updatedAt", "version" FROM "Case";
DROP TABLE "Case";
ALTER TABLE "new_Case" RENAME TO "Case";
CREATE UNIQUE INDEX "Case_clientToken_key" ON "Case"("clientToken");
CREATE UNIQUE INDEX "Case_preparerToken_key" ON "Case"("preparerToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyKey_preparerId_scope_key_key" ON "IdempotencyKey"("preparerId", "scope", "key");
