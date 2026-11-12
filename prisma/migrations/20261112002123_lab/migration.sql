-- CreateTable
CREATE TABLE "LabRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "model" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "summary" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "LabResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "split" TEXT NOT NULL DEFAULT 'dev',
    "expected" TEXT NOT NULL,
    "detected" BOOLEAN NOT NULL,
    "rules" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "moneyMovedWrongly" BOOLEAN NOT NULL,
    "readerOk" INTEGER NOT NULL,
    "readerTotal" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "tokensIn" INTEGER NOT NULL,
    "tokensOut" INTEGER NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "LabResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "LabRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "LabResult_runId_idx" ON "LabResult"("runId");
