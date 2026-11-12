/**
 * One-off backfill: media rows whose recorded type contradicts their own bytes.
 *
 * WHY THESE ROWS EXIST. Both upload paths used to record the type the CLIENT
 * declared (`File.type` in the browser), and that value is derived from the
 * FILENAME. A phone's camera roll routinely hands back JPEG bytes under a name
 * like `IMG_2676.PNG`, so perfectly ordinary uploads were written as
 * `image/png` while the stored blob was a JPEG. Decision #101 fixed the two
 * write paths (they now sniff the bytes); this repairs what they already wrote.
 *
 * WHY THE SERVE PATH IS ALREADY SAFE. `media.controller.read()` sniffs the
 * bytes and sets `Content-Type` from them, so those rows RENDER correctly
 * today. This script is about making the DATA agree with itself: `mimeType`
 * is read by the web pane (inline image vs download link), by the outbound
 * Meta /media upload, and by anyone querying the table. Leaving it wrong means
 * every future consumer has to remember to distrust the column.
 *
 * WHAT IT CAN AND CANNOT DO. It reads each row's bytes through the configured
 * StorageProvider and sniffs them - so it only ever records a type it has
 * OBSERVED. When the bytes are a format the sniffer does not recognise
 * (office documents, archives), it leaves the row alone and says so. It never
 * guesses, and it never deletes or re-uploads a blob.
 *
 * SAFETY.
 *   - DRY RUN BY DEFAULT. Writes require --apply.
 *   - Re-reads each row inside the write transaction and re-checks the
 *     mismatch, so a row fixed by someone else (or by a second run) is skipped
 *     rather than overwritten.
 *   - Writes an AuditLog row per repair recording before/after, so every change
 *     is attributable and reversible.
 *   - `--actor` is REQUIRED for a write: the audit policy needs a real user,
 *     and an unattributed data change is not acceptable.
 *   - A blob that cannot be fetched (404, provider down) is reported and
 *     skipped - never treated as "no mismatch".
 *
 * USAGE (from the repo root; DATABASE_URL must be the DIRECT/owner connection,
 * since this is a maintenance task rather than an app request - the app role's
 * RLS policies require app.user_* GUCs this script deliberately does not set):
 *
 *   # 1. See the damage. Read-only.
 *   DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/backfill-media-mime.ts
 *
 *   # 2. Repair everything that can be identified from its bytes.
 *   DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/backfill-media-mime.ts \
 *     --apply --actor <operatorUserId>
 *
 *   # 3. Narrow to one table while investigating.
 *   ... --apply --actor <id> --table ProgressPhoto
 */
import { prisma } from '@shadhil/database';

import { ImageKitStorage } from '../src/storage/imagekit.storage';
import { LocalDiskStorage } from '../src/storage/local-disk.storage';
import { sniffMime, type SniffedMime } from '../src/storage/sniff-mime';
import type { StorageProvider } from '../src/storage/storage.provider';
import { resolveMediaDir } from './lib/media-dir';

/** Tables that carry a stored media type keyed by a storage key. */
const TABLES = ['ProgressPhoto', 'Message', 'OutboundMessage'] as const;
type TableName = (typeof TABLES)[number];

type Candidate = {
  table: TableName;
  id: string;
  organizationId: string;
  key: string;
  recorded: string;
};

type Finding = Candidate & { sniffed: SniffedMime };

type Unreadable = Candidate & { reason: string };

type UnknownFormat = Candidate & { bytes: number };

/**
 * THE READ TRAP THIS GUARD EXISTS FOR.
 *
 * The app connects through the non-owner `shadhil_app` role, which is subject
 * to RLS. Policies are keyed on `app.user_id` / `app.user_org_id`, and this
 * script deliberately does NOT set them (it is a maintenance task across the
 * whole organization, not a request from one user). Without those GUCs, RLS
 * filters every row away.
 *
 * The failure mode is SILENT AND REASSURING: the script would print "every row
 * agrees with its bytes" while the defect is untouched. A clean bill of health
 * is the worst possible output for a repair tool, so we verify we can actually
 * see rows before trusting any result.
 */
async function assertCanSeeData(): Promise<void> {
  const [photos, messages] = await Promise.all([
    prisma.progressPhoto.count(),
    prisma.message.count(),
  ]);
  const total = photos + messages;
  if (total > 0) {
    console.log(
      `(connection can see ${photos} progress photo(s) + ${messages} message(s) - results are trustworthy)`,
    );
    return;
  }
  throw new Error(
    [
      'Refusing to report: this connection cannot see ANY media rows.',
      '',
      'That almost always means DATABASE_URL points at the non-owner `shadhil_app`',
      'role, whose RLS policies require `app.user_id` / `app.user_org_id` to be set.',
      'This script does not set them (it is not a user request), so an empty result',
      'here would be a lie rather than a clean bill of health.',
      '',
      'Re-run with the DIRECT (owner) connection, which bypasses RLS:',
      '  DATABASE_URL="$DIRECT_DATABASE_URL" npx tsx apps/backend/scripts/backfill-media-mime.ts',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): {
  apply: boolean;
  actor?: string;
  table?: TableName;
  reason?: string;
} {
  const out: { apply: boolean; actor?: string; table?: TableName; reason?: string } = {
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--actor') out.actor = argv[++i];
    else if (arg === '--reason') out.reason = argv[++i];
    else if (arg === '--table') {
      const name = argv[++i];
      if (!TABLES.includes(name as TableName)) {
        throw new Error(`--table must be one of: ${TABLES.join(', ')} (got "${name}")`);
      }
      out.table = name as TableName;
    }
  }
  return out;
}

/**
 * Build the provider the same way StorageModule does. Kept in step with
 * `src/storage/storage.module.ts` - if a third provider lands, both must learn
 * it, which is exactly the one-adapter seam the StorageProvider interface buys.
 */
function makeStorage(): StorageProvider {
  return process.env.MEDIA_STORAGE === 'imagekit'
    ? new ImageKitStorage()
    : new LocalDiskStorage(resolveMediaDir().dir);
}

/** Every row that has a storage key and a recorded type, across all tables. */
async function findCandidates(table: TableName | undefined): Promise<Candidate[]> {
  const wanted = table === undefined ? TABLES : [table];
  const out: Candidate[] = [];

  for (const name of wanted) {
    if (name === 'ProgressPhoto') {
      const rows = await prisma.progressPhoto.findMany({
        select: { id: true, organizationId: true, key: true, mimeType: true },
        orderBy: { createdAt: 'asc' },
      });
      out.push(
        ...rows.map((r) => ({
          table: name,
          id: r.id,
          organizationId: r.organizationId,
          key: r.key,
          recorded: r.mimeType,
        })),
      );
    } else if (name === 'Message') {
      const rows = await prisma.message.findMany({
        where: { mediaKey: { not: null }, mediaType: { not: null } },
        select: { id: true, organizationId: true, mediaKey: true, mediaType: true },
        orderBy: { createdAt: 'asc' },
      });
      out.push(
        ...rows.map((r) => ({
          table: name,
          id: r.id,
          organizationId: r.organizationId,
          key: r.mediaKey as string,
          recorded: r.mediaType as string,
        })),
      );
    } else {
      const rows = await prisma.outboundMessage.findMany({
        where: { mediaKey: { not: null }, mediaType: { not: null } },
        select: { id: true, organizationId: true, mediaKey: true, mediaType: true },
      });
      out.push(
        ...rows.map((r) => ({
          table: name,
          id: r.id,
          organizationId: r.organizationId,
          key: r.mediaKey as string,
          recorded: r.mediaType as string,
        })),
      );
    }
  }
  return out;
}

type ScanResult = {
  candidates: number;
  findings: Finding[];
  unreadable: Unreadable[];
  unknown: UnknownFormat[];
  agree: number;
};

async function scan(storage: StorageProvider, table: TableName | undefined): Promise<ScanResult> {
  const candidates = await findCandidates(table);
  const findings: Finding[] = [];
  const unreadable: Unreadable[] = [];
  const unknown: UnknownFormat[] = [];
  let agree = 0;

  for (const c of candidates) {
    const buf = await storage.read(c.key);
    if (buf === null) {
      // NEVER counted as agreement: we could not see the bytes, so we know
      // nothing about them.
      unreadable.push({ ...c, reason: 'blob not readable (404 or provider error)' });
      continue;
    }
    const sniffed = sniffMime(buf);
    if (sniffed === null) {
      unknown.push({ ...c, bytes: buf.length });
      continue;
    }
    if (sniffed === c.recorded.toLowerCase()) {
      agree += 1;
      continue;
    }
    findings.push({ ...c, sniffed });
  }

  return { candidates: candidates.length, findings, unreadable, unknown, agree };
}

function printReport(r: ScanResult): void {
  console.log('');
  console.log('Media rows whose recorded type contradicts their bytes');
  console.log('----------------------------------------------------');
  console.log(`Scanned ${r.candidates} row(s) with a stored key.`);
  console.log(`  agree with their bytes : ${r.agree}`);
  console.log(`  MISMATCHED             : ${r.findings.length}`);
  console.log(`  unreadable blob        : ${r.unreadable.length}`);
  console.log(`  unrecognised format    : ${r.unknown.length}`);
  console.log('');

  if (r.findings.length > 0) {
    console.log('Mismatched (recorded -> bytes):');
    for (const f of r.findings) {
      console.log(`  ${f.table} ${f.id}`);
      console.log(`    key=${f.key}`);
      console.log(`    recorded ${f.recorded}  ->  bytes are ${f.sniffed}`);
    }
    console.log('');
  }

  if (r.unreadable.length > 0) {
    console.log('Could NOT read the blob - left untouched (fix the key/provider, then re-run):');
    for (const u of r.unreadable) {
      console.log(`  ${u.table} ${u.id}  ${u.reason}`);
      console.log(`    key=${u.key}`);
    }
    console.log('');
  }

  if (r.unknown.length > 0) {
    console.log('Bytes are a format the sniffer cannot identify - left untouched by design:');
    for (const u of r.unknown) {
      console.log(`  ${u.table} ${u.id}  (${u.bytes} bytes, recorded ${u.recorded})`);
      console.log(`    key=${u.key}`);
    }
    console.log('');
  }
}

/** The column that holds the type, per table. */
function typeColumn(table: TableName): 'mimeType' | 'mediaType' {
  return table === 'ProgressPhoto' ? 'mimeType' : 'mediaType';
}

/** The column that holds the storage key, per table. */
function keyColumn(table: TableName): 'key' | 'mediaKey' {
  return table === 'ProgressPhoto' ? 'key' : 'mediaKey';
}

/**
 * Repair ONE row. Re-reads it inside the transaction and re-checks the
 * recorded value, so a concurrent fix is skipped instead of clobbered.
 */
async function repairOne(
  finding: Finding,
  actor: string,
  fallbackReason: string | undefined,
): Promise<'repaired' | 'skipped-already-correct' | 'skipped-row-gone'> {
  const typeCol = typeColumn(finding.table);
  const keyCol = keyColumn(finding.table);

  return prisma.$transaction(async (tx) => {
    // The three tables share no base type in Prisma's client, so each needs
    // its own accessor. The casts are local and load-bearing: the generic
    // delegate cannot be indexed dynamically without them.
    let current: Record<string, unknown> | null;
    if (finding.table === 'ProgressPhoto') {
      current = (await tx.progressPhoto.findUnique({
        where: { id: finding.id },
        select: { id: true, organizationId: true, key: true, mimeType: true },
      })) as Record<string, unknown> | null;
    } else if (finding.table === 'Message') {
      current = (await tx.message.findUnique({
        where: { id: finding.id },
        select: { id: true, organizationId: true, mediaKey: true, mediaType: true },
      })) as Record<string, unknown> | null;
    } else {
      current = (await tx.outboundMessage.findUnique({
        where: { id: finding.id },
        select: { id: true, organizationId: true, mediaKey: true, mediaType: true },
      })) as Record<string, unknown> | null;
    }

    if (current === null) return 'skipped-row-gone' as const;

    const before = current[typeCol];
    if (typeof before !== 'string' || before.toLowerCase() === finding.sniffed) {
      // Someone already fixed it (or it was never broken). Never overwrite.
      return 'skipped-already-correct' as const;
    }
    // The key must still be the one we sniffed - a re-upload would give us no
    // evidence about the NEW bytes.
    if (current[keyCol] !== finding.key) return 'skipped-row-gone' as const;

    if (finding.table === 'ProgressPhoto') {
      await tx.progressPhoto.update({
        where: { id: finding.id },
        data: { mimeType: finding.sniffed },
      });
    } else if (finding.table === 'Message') {
      await tx.message.update({ where: { id: finding.id }, data: { mediaType: finding.sniffed } });
    } else {
      await tx.outboundMessage.update({
        where: { id: finding.id },
        data: { mediaType: finding.sniffed },
      });
    }

    await tx.auditLog.create({
      data: {
        userId: actor,
        organizationId: finding.organizationId,
        action: 'media.mime_type_repair',
        entityType: finding.table,
        entityId: finding.id,
        before: { [typeCol]: before },
        after: { [typeCol]: finding.sniffed },
        reason:
          fallbackReason ??
          'Recorded type contradicted the stored bytes (client-declared type from the filename); corrected from the bytes',
      },
    });
    return 'repaired' as const;
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const storage = makeStorage();

  // Always show the damage first, even on a write run - the operator should see
  // the state they are changing.
  await assertCanSeeData();
  const result = await scan(storage, args.table);
  printReport(result);

  if (result.findings.length === 0) {
    console.log('Nothing to repair. Every readable row agrees with its bytes.');
    console.log('');
    return;
  }

  if (!args.apply) {
    console.log('DRY RUN - nothing was written. Re-run with --apply to repair.');
    console.log('');
    return;
  }

  if (args.actor === undefined || args.actor.trim().length === 0) {
    throw new Error(
      'Refusing to write without --actor <userId>: the change must be attributable, and the audit policy requires a real user.',
    );
  }

  let repaired = 0;
  for (const finding of result.findings) {
    const outcome = await repairOne(finding, args.actor, args.reason);
    console.log(`  ${finding.table} ${finding.id} -> ${outcome}`);
    if (outcome === 'repaired') repaired += 1;
  }

  console.log('');
  console.log(`Repaired ${repaired} of ${result.findings.length} mismatched row(s).`);

  // Re-scan so the final line is measured, not assumed.
  const after = await scan(storage, args.table);
  console.log(
    `Still mismatched: ${after.findings.length}. Unreadable (untouched): ${after.unreadable.length}.`,
  );
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
