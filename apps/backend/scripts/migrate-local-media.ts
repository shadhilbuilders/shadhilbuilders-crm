/**
 * One-off: blobs that exist on the LOCAL DISK but not in the active provider.
 *
 * WHY THESE ROWS EXIST. `StorageProvider` is swappable behind `MEDIA_STORAGE`.
 * Rows written while the app ran with `MEDIA_STORAGE=local` hold a LocalDisk
 * key (`<org>/<cuid>/<name>`, deliberately slashless) and their bytes were
 * written to `MEDIA_DIR`. Flipping the env to `MEDIA_STORAGE=imagekit` swaps
 * where NEW uploads go, but those older keys still point at a disk the
 * provider no longer reads. The result is a row that renders nowhere: the
 * public CDN has no such object and the BFF proxy 404s.
 *
 * This is not hypothetical - the 2026-11-06 audit found one
 * (`OutboundMessage cmu5k9qpq0002k0u8sluetf43`, a 70-byte 1x1 PNG). It had
 * already been DELIVERED to WhatsApp while the app was on local disk, so the
 * customer got the image; every read since has failed.
 *
 * WHAT IT DOES. For each row whose blob the ACTIVE provider cannot read, look
 * for the same key on the local disk. If the bytes are there, upload them
 * through the active provider and rewrite the row's key to the key the
 * provider returns (ImageKit prefixes its folder with `/`, so the stored form
 * changes shape - that is why this rewrites rather than just re-uploading).
 *
 * SAFETY.
 *   - DRY RUN BY DEFAULT. Writes require --apply.
 *   - Only rows the ACTIVE provider cannot read are candidates; a readable
 *     blob is never re-uploaded or duplicated.
 *   - The bytes are re-checked against the local file inside the transaction's
 *     predecessor (upload happens first, as it must - bytes exist before the
 *     row references them), and the row is only rewritten if its key is still
 *     the one we looked up.
 *   - One AuditLog row per rewrite, recording before/after keys.
 *   - If the upload succeeds but the row update fails, the freshly uploaded
 *     blob is deleted (best effort) so a failed run does not litter the
 *     provider - the same compensation contract the upload endpoints use.
 *   - `--actor` is REQUIRED for a write.
 *
 * USAGE (from the repo root; DATABASE_URL must be the DIRECT/owner connection,
 * and MEDIA_DIR must point at the disk the old blobs were written to):
 *
 *   # 1. See what is stranded. Read-only.
 *   DATABASE_URL="$DIRECT_DATABASE_URL" \
 *     MEDIA_DIR=apps/backend/media \
 *     npx tsx apps/backend/scripts/migrate-local-media.ts
 *
 *   # 2. Upload the stranded blobs and rewrite their keys.
 *   DATABASE_URL="$DIRECT_DATABASE_URL" \
 *     MEDIA_DIR=apps/backend/media \
 *     npx tsx apps/backend/scripts/migrate-local-media.ts --apply --actor <operatorUserId>
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { prisma } from '@shadhil/database';

import { ImageKitStorage } from '../src/storage/imagekit.storage';
import { LocalDiskStorage } from '../src/storage/local-disk.storage';
import type { StorageProvider } from '../src/storage/storage.provider';
import { describeMediaDir, resolveMediaDir } from './lib/media-dir';

const TABLES = ['ProgressPhoto', 'Message', 'OutboundMessage'] as const;
type TableName = (typeof TABLES)[number];

type Stranded = {
  table: TableName;
  id: string;
  organizationId: string;
  /** The key as currently stored (may be slashless on legacy rows). */
  key: string;
  filename: string | null;
  size: number;
};

type RowRef = {
  table: TableName;
  id: string;
  organizationId: string;
  key: string;
  filename: string | null;
};

/**
 * The same read trap as the other repair scripts: the app role is subject to
 * RLS, and this script sets no `app.user_*` GUCs, so an empty result would be
 * a lie rather than a clean bill of health.
 */
async function assertCanSeeData(): Promise<void> {
  const [photos, messages] = await Promise.all([
    prisma.progressPhoto.count(),
    prisma.message.count(),
  ]);
  const total = photos + messages;
  if (total > 0) {
    console.log(`(connection can see ${photos} progress photo(s) + ${messages} message(s) - results are trustworthy)`);
    return;
  }
  throw new Error(
    [
      'Refusing to report: this connection cannot see ANY media rows.',
      '',
      'That almost always means DATABASE_URL points at the non-owner `shadhil_app`',
      'role, whose RLS policies require `app.user_id` / `app.user_org_id`. Re-run with',
      'the DIRECT (owner) connection:',
      '  DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/migrate-local-media.ts',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): { apply: boolean; actor?: string; reason?: string } {
  const out: { apply: boolean; actor?: string; reason?: string } = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--actor') out.actor = argv[++i];
    else if (arg === '--reason') out.reason = argv[++i];
  }
  return out;
}

/** The active provider, built exactly as StorageModule builds it. */
function makeActiveStorage(): StorageProvider {
  return process.env.MEDIA_STORAGE === 'imagekit'
    ? new ImageKitStorage()
    : new LocalDiskStorage(resolveMediaDir().dir);
}

function makeLocalDisk(): LocalDiskStorage {
  return new LocalDiskStorage(resolveMediaDir().dir);
}

/** Every row with a stored key, across all three tables. */
async function findRows(): Promise<RowRef[]> {
  const out: RowRef[] = [];

  const photos = await prisma.progressPhoto.findMany({
    select: { id: true, organizationId: true, key: true, filename: true },
  });
  out.push(
    ...photos.map((r) => ({
      table: 'ProgressPhoto' as const,
      id: r.id,
      organizationId: r.organizationId,
      key: r.key,
      filename: r.filename,
    })),
  );

  const messages = await prisma.message.findMany({
    where: { mediaKey: { not: null } },
    select: { id: true, organizationId: true, mediaKey: true, mediaFilename: true },
  });
  out.push(
    ...messages
      .filter((r) => typeof r.mediaKey === 'string' && r.mediaKey.length > 0)
      .map((r) => ({
        table: 'Message' as const,
        id: r.id,
        organizationId: r.organizationId,
        key: r.mediaKey as string,
        filename: r.mediaFilename,
      })),
  );

  const outbound = await prisma.outboundMessage.findMany({
    where: { mediaKey: { not: null } },
    select: { id: true, organizationId: true, mediaKey: true, mediaFilename: true },
  });
  out.push(
    ...outbound
      .filter((r) => typeof r.mediaKey === 'string' && r.mediaKey.length > 0)
      .map((r) => ({
        table: 'OutboundMessage' as const,
        id: r.id,
        organizationId: r.organizationId,
        key: r.mediaKey as string,
        filename: r.mediaFilename,
      })),
  );

  return out;
}

/**
 * Find rows whose bytes the active provider cannot read but the local disk
 * still has. A row readable through the ACTIVE provider is not a candidate -
 * this script must never duplicate a healthy blob.
 */
async function scan(active: StorageProvider, disk: LocalDiskStorage): Promise<{
  checked: number;
  readable: number;
  stranded: Stranded[];
  gone: RowRef[];
}> {
  const rows = await findRows();
  const stranded: Stranded[] = [];
  const gone: RowRef[] = [];
  let readable = 0;

  for (const row of rows) {
    const viaProvider = await active.read(row.key);
    if (viaProvider !== null) {
      readable += 1;
      continue;
    }
    // The active provider could not serve it. Is the blob on the old disk?
    const viaDisk = await disk.read(row.key);
    if (viaDisk === null) {
      gone.push(row);
      continue;
    }
    stranded.push({
      table: row.table,
      id: row.id,
      organizationId: row.organizationId,
      key: row.key,
      filename: row.filename,
      size: viaDisk.length,
    });
  }

  return { checked: rows.length, readable, stranded, gone };
}

function printReport(r: Awaited<ReturnType<typeof scan>>): void {
  console.log('');
  console.log('Blobs the ACTIVE provider cannot serve');
  console.log('--------------------------------------');
  console.log(`Checked ${r.checked} row(s) with a stored key.`);
  console.log(`  readable via provider   : ${r.readable}`);
  console.log(`  present on LOCAL DISK   : ${r.stranded.length}   <- recoverable`);
  console.log(`  nowhere (bytes lost)    : ${r.gone.length}`);
  console.log('');

  if (r.stranded.length > 0) {
    console.log('Recoverable (upload these to the active provider):');
    for (const s of r.stranded) {
      console.log(`  ${s.table} ${s.id}`);
      console.log(`    key=${s.key}`);
      console.log(`    ${s.size} bytes on local disk${s.filename ? ` (${s.filename})` : ''}`);
    }
    console.log('');
  }

  if (r.gone.length > 0) {
    console.log('Bytes exist nowhere the script can reach - left untouched:');
    for (const g of r.gone) {
      console.log(`  ${g.table} ${g.id}`);
      console.log(`    key=${g.key}`);
    }
    console.log('');
  }
}

function typeColumn(table: TableName): 'mimeType' | 'mediaType' {
  return table === 'ProgressPhoto' ? 'mimeType' : 'mediaType';
}

/**
 * Upload one stranded blob and repoint its row.
 *
 * Upload happens BEFORE the row update because the row must reference bytes
 * that already exist. If the update then fails, the new blob is deleted so a
 * failed run leaves no litter.
 */
async function migrateOne(
  stranded: Stranded,
  active: StorageProvider,
  disk: LocalDiskStorage,
  actor: string,
  fallbackReason: string | undefined,
): Promise<'migrated' | 'skipped-key-changed' | 'skipped-row-gone'> {
  const bytes = await disk.read(stranded.key);
  if (bytes === null) return 'skipped-row-gone';

  // Re-derive the recorded type from the bytes, so the migrated row is also
  // self-consistent (the same rule decision #101 applies at upload time).
  const { reconcileUploadMime } = await import('../src/storage/sniff-mime');
  const sniffed = reconcileUploadMime(bytes, 'application/octet-stream')?.mimeType;

  const stored = await active.save(bytes, {
    organizationId: stranded.organizationId,
    mimeType: sniffed ?? 'application/octet-stream',
    filename: stranded.filename ?? stranded.key.split('/').pop() ?? 'file',
  });

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const typeCol = typeColumn(stranded.table);

      let current: Record<string, unknown> | null;
      if (stranded.table === 'ProgressPhoto') {
        current = (await tx.progressPhoto.findUnique({
          where: { id: stranded.id },
          select: { id: true, organizationId: true, key: true, mimeType: true },
        })) as Record<string, unknown> | null;
      } else if (stranded.table === 'Message') {
        current = (await tx.message.findUnique({
          where: { id: stranded.id },
          select: { id: true, organizationId: true, mediaKey: true, mediaType: true },
        })) as Record<string, unknown> | null;
      } else {
        current = (await tx.outboundMessage.findUnique({
          where: { id: stranded.id },
          select: { id: true, organizationId: true, mediaKey: true, mediaType: true },
        })) as Record<string, unknown> | null;
      }
      if (current === null) return 'skipped-row-gone' as const;
      if (current[stranded.table === 'ProgressPhoto' ? 'key' : 'mediaKey'] !== stranded.key) {
        // Someone re-keyed the row since we scanned; our bytes are evidence
        // about the OLD key only.
        return 'skipped-key-changed' as const;
      }

      const patch: Record<string, unknown> = {
        [stranded.table === 'ProgressPhoto' ? 'key' : 'mediaKey']: stored.key,
      };
      if (sniffed !== undefined) patch[typeCol] = sniffed;

      if (stranded.table === 'ProgressPhoto') {
        await tx.progressPhoto.update({ where: { id: stranded.id }, data: patch });
      } else if (stranded.table === 'Message') {
        // Keep the legacy display URL in step with the new key.
        await tx.message.update({
          where: { id: stranded.id },
          data: { ...patch, mediaUrl: `/api/bff/media/${encodeURIComponent(stored.key)}` },
        });
      } else {
        await tx.outboundMessage.update({ where: { id: stranded.id }, data: patch });
      }

      await tx.auditLog.create({
        data: {
          userId: actor,
          organizationId: stranded.organizationId,
          action: 'media.local_blob_migrated',
          entityType: stranded.table,
          entityId: stranded.id,
          before: { key: stranded.key },
          after: { key: stored.key, mimeType: sniffed ?? null },
          reason:
            fallbackReason ??
            'Blob existed only on local disk after MEDIA_STORAGE moved to the active provider; re-uploaded and re-keyed',
        },
      });
      return 'migrated' as const;
    });

    if (outcome !== 'migrated') {
      // The row was not repointed, so the fresh upload is unreferenced.
      await active.delete(stored.key);
    }
    return outcome;
  } catch (err) {
    await active.delete(stored.key);
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const active = makeActiveStorage();
  const disk = makeLocalDisk();

  const mediaDir = resolveMediaDir().dir;
  console.log(`active provider : ${process.env.MEDIA_STORAGE === 'imagekit' ? 'imagekit' : 'local-disk'}`);
  console.log(describeMediaDir());
  if (!existsSync(join(mediaDir))) {
    console.log(`(warning: ${join(mediaDir)} does not exist - no blob can be recovered)`);
  }

  await assertCanSeeData();
  const result = await scan(active, disk);
  printReport(result);

  if (result.stranded.length === 0) {
    console.log('Nothing to migrate. Every readable blob is served by the active provider.');
    console.log('');
    return;
  }

  if (!args.apply) {
    console.log('DRY RUN - nothing was uploaded or rewritten. Re-run with --apply.');
    console.log('');
    return;
  }
  if (args.actor === undefined || args.actor.trim().length === 0) {
    throw new Error('Refusing to write without --actor <userId>: the change must be attributable.');
  }

  let migrated = 0;
  for (const s of result.stranded) {
    const outcome = await migrateOne(s, active, disk, args.actor, args.reason);
    console.log(`  ${s.table} ${s.id} -> ${outcome}`);
    if (outcome === 'migrated') migrated += 1;
  }

  console.log('');
  console.log(`Migrated ${migrated} of ${result.stranded.length} stranded blob(s).`);

  const after = await scan(active, disk);
  console.log(`Still stranded: ${after.stranded.length}. Lost beyond recovery: ${after.gone.length}.`);
  console.log('');
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('');
    console.error(err instanceof Error ? err.message : String(err));
    console.error('');
    await prisma.$disconnect();
    process.exit(1);
  });
