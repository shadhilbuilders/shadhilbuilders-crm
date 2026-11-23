// Byte ledgers for site video: one row per organisation, one per project
// (2026-11-23).
//
// Both caps are enforced by a CONDITIONAL UPDATE (`usedBytes + size <= cap`) in
// the same transaction as the row insert, so two concurrent records cannot both
// squeeze under the line, and a cap failure rolls the whole record back. The org
// row is always updated before the project row: one lock order everywhere means
// two records cannot deadlock each other.
//
// Sizes are the SERVER-verified `stat` size, never a client claim.
import { Prisma, type RlsTx } from '@shadhil/database';

import { siteVideoError } from './site-video.errors';

export interface LedgerCaps {
  orgCapBytes: number;
  projectCapBytes: number;
}

export interface LedgerScope {
  organizationId: string;
  projectId: string;
}

/** Create the ledger rows if absent. Cheap, idempotent, and safe under RLS. */
async function ensureRows(tx: RlsTx, scope: LedgerScope): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "StorageUsage" ("organizationId", "usedBytes", "reservedBytes", "updatedAt")
    VALUES (${scope.organizationId}, 0, 0, NOW())
    ON CONFLICT ("organizationId") DO NOTHING`);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "ProjectStorageUsage" ("projectId", "organizationId", "usedBytes", "updatedAt")
    VALUES (${scope.projectId}, ${scope.organizationId}, 0, NOW())
    ON CONFLICT ("projectId") DO NOTHING`);
}

/**
 * Add `bytes` to both ledgers, or throw VIDEO_STORAGE_CAP_REACHED naming the
 * scope that is full. Must run inside the record transaction.
 */
export async function chargeLedgers(
  tx: RlsTx,
  scope: LedgerScope,
  bytes: number,
  caps: LedgerCaps,
): Promise<void> {
  await ensureRows(tx, scope);

  const org = await tx.$executeRaw(Prisma.sql`
    UPDATE "StorageUsage"
    SET "usedBytes" = "usedBytes" + ${bytes}, "updatedAt" = NOW()
    WHERE "organizationId" = ${scope.organizationId}
      AND "usedBytes" + ${bytes} <= ${caps.orgCapBytes}`);
  if (org === 0) {
    throw siteVideoError('VIDEO_STORAGE_CAP_REACHED', { scope: 'ORGANIZATION' });
  }

  const project = await tx.$executeRaw(Prisma.sql`
    UPDATE "ProjectStorageUsage"
    SET "usedBytes" = "usedBytes" + ${bytes}, "updatedAt" = NOW()
    WHERE "projectId" = ${scope.projectId}
      AND "organizationId" = ${scope.organizationId}
      AND "usedBytes" + ${bytes} <= ${caps.projectCapBytes}`);
  if (project === 0) {
    throw siteVideoError('VIDEO_STORAGE_CAP_REACHED', { scope: 'PROJECT' });
  }
}

/** Give `bytes` back to both ledgers, never below zero. Runs in the delete transaction. */
export async function creditLedgers(tx: RlsTx, scope: LedgerScope, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "StorageUsage"
    SET "usedBytes" = GREATEST("usedBytes" - ${bytes}, 0), "updatedAt" = NOW()
    WHERE "organizationId" = ${scope.organizationId}`);
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ProjectStorageUsage"
    SET "usedBytes" = GREATEST("usedBytes" - ${bytes}, 0), "updatedAt" = NOW()
    WHERE "projectId" = ${scope.projectId} AND "organizationId" = ${scope.organizationId}`);
}

/**
 * Advisory check at grant time: is there headroom for one more maximum-size
 * clip? Guidance only (a grant stays valid for minutes and uploads bypass the
 * server), the enforced limit is `chargeLedgers` at record time.
 */
export async function assertHeadroom(
  tx: RlsTx,
  scope: LedgerScope,
  maxBytes: number,
  caps: LedgerCaps,
): Promise<void> {
  const [org, project] = await Promise.all([
    tx.storageUsage.findUnique({
      where: { organizationId: scope.organizationId },
      select: { usedBytes: true },
    }),
    tx.projectStorageUsage.findUnique({
      where: { projectId: scope.projectId },
      select: { usedBytes: true },
    }),
  ]);
  if (Number(org?.usedBytes ?? 0n) + maxBytes > caps.orgCapBytes) {
    throw siteVideoError('VIDEO_STORAGE_CAP_REACHED', { scope: 'ORGANIZATION' });
  }
  if (Number(project?.usedBytes ?? 0n) + maxBytes > caps.projectCapBytes) {
    throw siteVideoError('VIDEO_STORAGE_CAP_REACHED', { scope: 'PROJECT' });
  }
}
