-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "issuer" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Account_issuer_key" ON "Account"("issuer");

