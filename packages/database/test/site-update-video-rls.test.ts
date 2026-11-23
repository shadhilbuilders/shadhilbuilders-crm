// ────────────────────────────────────────────────────────────────────────────
// Site update video, step 1 of 8 - schema + RLS (2026-11-23)
// ────────────────────────────────────────────────────────────────────────────
// Migration under test: 20261123120000_progress_photo_video.
//
// protects= the new invariants and policies actually bind:
//             - a live VIDEO row cannot exist without poster/duration/size,
//               a duration outside 1..45s, or a size above 14MiB;
//             - a row that is not archived cannot exist without a key;
//             - an engineer sees only their own villa's delivery rows, an
//               ADMIN sees the org, another org sees nothing;
//             - the cron claim needs BOTH the role and the sentinel user id,
//               so a forged role with a real user id is denied;
//             - StorageUsage is one row per org, invisible across orgs.
// fails_when= any policy grants beyond the villa/org boundary, a CHECK lets a
//             half-written video through, or `kind` defaults to anything but
//             PHOTO for an existing insert path.
// no_claim= nothing about the service layer, the mapper, or the UI. Step 5
//           owns those. A green run here does not mean a clip can be uploaded.
//
// Fixture discipline follows progress-rls.test.ts: owner-role client from
// DIRECT_DATABASE_URL seeds (BYPASSRLS), withRlsContext probes under the
// policy. Rows are created and deleted by this suite only, with a distinct
// `suv` id prefix so nothing collides with a sibling suite's namespace.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { withRlsContext } from '../src/rls';
import { createDirectPrismaClient } from '../src/test-db-isolation';

import { DATABASE_AVAILABLE } from './setup';

const adminPrisma = createDirectPrismaClient();

const ORG_A = 'ceid01lpfe1esm8jwsxid41k28'; // seeded demo org
const ORG_B = 'suv0000000000000000000org'; // throwaway sibling org for leak probes

const fid = (tag: string): string => `suv${tag}`.padEnd(24, '0');

const MGR_A = fid('mgr');
const ENG_A = fid('enga'); // engineer, team A, assigned UNIT_A
const ENG_N = fid('engn'); // engineer, no membership
const ADM_A = fid('adm');
const CUST_A = fid('cust'); // buyer in org A: must never write staff tables
const TEAM_A = fid('team');
const PROJ_A = fid('proja');
const PHASE_A = fid('phse');
const UNIT_A = fid('unit'); // assigned to ENG_A
const UNIT_FREE = fid('unif'); // same project/team, unassigned
const ORG_B_UNIT = fid('unitb');
const PROJ_B = fid('prjb');
const PHASE_B = fid('phsb');

const MAX_VIDEO_BYTES = 14 * 1024 * 1024; // 14680064, the CHECK's ceiling

const BATCH_MEMBER = fid('btch');
const BATCH_CRON = fid('btcc');
const BATCH_FORGE = fid('btcf');

async function cleanup(): Promise<void> {
  await adminPrisma.siteUpdateDelivery.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] }, batchId: { startsWith: 'suv' } },
  });
  await adminPrisma.storageUsage.deleteMany({
    where: { organizationId: { in: [ORG_A, ORG_B] } },
  });
  await adminPrisma.progressPhoto.deleteMany({ where: { id: { startsWith: 'suv' } } });
  await adminPrisma.projectStaffRole.deleteMany({ where: { userId: { startsWith: 'suv' } } });
  await adminPrisma.teamMember.deleteMany({ where: { userId: { startsWith: 'suv' } } });
  await adminPrisma.unit.deleteMany({ where: { id: { in: [UNIT_A, UNIT_FREE, ORG_B_UNIT] } } });
  await adminPrisma.phase.deleteMany({ where: { id: { in: [PHASE_A, PHASE_B] } } });
  await adminPrisma.projectTeam.deleteMany({ where: { projectId: { in: [PROJ_A, PROJ_B] } } });
  await adminPrisma.project.deleteMany({ where: { id: { in: [PROJ_A, PROJ_B] } } });
  await adminPrisma.team.deleteMany({ where: { id: TEAM_A } });
  await adminPrisma.user.deleteMany({ where: { id: { startsWith: 'suv' } } });
  await adminPrisma.organization.deleteMany({ where: { id: ORG_B } });
}

async function buildFixture(): Promise<void> {
  await cleanup();

  for (const [id, role, email] of [
    [MGR_A, 'MANAGER', 'suv-mgr@fixture.x'],
    [ENG_A, 'ENGINEER', 'suv-enga@fixture.x'],
    [ENG_N, 'ENGINEER', 'suv-engn@fixture.x'],
    [ADM_A, 'ADMIN', 'suv-adm@fixture.x'],
    [CUST_A, 'CUSTOMER', 'suv-cust@fixture.x'],
  ] as const) {
    await adminPrisma.user.create({
      data: { id, email, name: id, role, emailVerified: true, organizationId: ORG_A },
    });
  }

  await adminPrisma.organization.create({
    data: { id: ORG_B, name: 'Sibling Org', slug: 'suv-sibling-org' },
  });

  await adminPrisma.team.create({
    data: { id: TEAM_A, name: 'SUV Team', managerId: MGR_A, organizationId: ORG_A },
  });
  await adminPrisma.teamMember.create({
    data: { userId: ENG_A, teamId: TEAM_A, organizationId: ORG_A },
  });

  await adminPrisma.project.create({
    data: {
      id: PROJ_A,
      name: 'SUV Project',
      slug: 'suv-project',
      address: '1 SUV Rd',
      organizationId: ORG_A,
    },
  });
  await adminPrisma.projectTeam.create({
    data: { projectId: PROJ_A, teamId: TEAM_A, organizationId: ORG_A },
  });
  await adminPrisma.phase.create({
    data: { id: PHASE_A, projectId: PROJ_A, name: 'SUV Phase', organizationId: ORG_A },
  });

  const unit = (
    id: string,
    num: string,
    org: string,
    phaseId: string,
    engineer: string | null,
  ) => ({
    id,
    phaseId,
    unitNumber: num,
    bhk: 3,
    buildupSqft: '1000.00',
    pricePerSqft: '10000.00',
    price: '10000000.00',
    organizationId: org,
    assignedEngineerId: engineer,
  });

  await adminPrisma.unit.create({ data: unit(UNIT_A, 'SUV-A1', ORG_A, PHASE_A, ENG_A) });
  await adminPrisma.unit.create({ data: unit(UNIT_FREE, 'SUV-A2', ORG_A, PHASE_A, null) });

  // Sibling org needs its own project/phase/unit: a delivery row has a real
  // FKEY to Unit, so a dangling id cannot stand in for the cross-org probe.
  await adminPrisma.project.create({
    data: {
      id: PROJ_B,
      name: 'Sibling Project',
      slug: 'suv-sibling-project',
      address: '2 SUV Rd',
      organizationId: ORG_B,
    },
  });
  await adminPrisma.phase.create({
    data: { id: PHASE_B, projectId: PROJ_B, name: 'Sibling Phase', organizationId: ORG_B },
  });
  await adminPrisma.unit.create({ data: unit(ORG_B_UNIT, 'SUV-B1', ORG_B, PHASE_B, null) });
}

const engA = { userId: ENG_A, role: 'ENGINEER' as const, organizationId: ORG_A };
const engN = { userId: ENG_N, role: 'ENGINEER' as const, organizationId: ORG_A };
const mgrA = { userId: MGR_A, role: 'MANAGER' as const, organizationId: ORG_A };
const admA = { userId: ADM_A, role: 'ADMIN' as const, organizationId: ORG_A };
const cronA = { userId: 'cron-service', role: 'CRON_SERVICE' as const, organizationId: ORG_A };
/** The impersonation pair: role CRON_SERVICE, a real user's id. */
const cronForge = { userId: ADM_A, role: 'CRON_SERVICE' as const, organizationId: ORG_A };
/** A buyer in the same org: must not touch the storage ledger. */
const custA = { userId: CUST_A, role: 'CUSTOMER' as const, organizationId: ORG_A };

const videoRow = (over: Record<string, unknown> = {}) => ({
  id: fid('vid'),
  unitId: UNIT_A,
  phaseId: PHASE_A,
  organizationId: ORG_A,
  kind: 'VIDEO' as const,
  key: 'progress/suv/clip.mp4',
  posterKey: 'progress/suv/poster.jpg',
  mimeType: 'video/mp4',
  filename: 'clip.mp4',
  caption: 'SUV clip',
  takenAt: new Date('2026-11-23T09:00:00Z'),
  sizeBytes: 4_000_000,
  durationMs: 30_000,
  ...over,
});

const maybe = DATABASE_AVAILABLE ? describe : describe.skip;

maybe('Site update video - schema invariants + RLS (step 1)', () => {
  beforeAll(buildFixture);
  afterAll(cleanup);

  // ── CHECK constraints ────────────────────────────────────────────────────
  // Run as the owner (BYPASSRLS) on purpose: the subject is the constraint,
  // not a policy. The policy probes come after.

  describe('ProgressPhoto video invariants', () => {
    it('rejects a live VIDEO with no poster', async () => {
      await expect(
        adminPrisma.progressPhoto.create({ data: videoRow({ posterKey: null }) }),
      ).rejects.toThrow();
    });

    it('rejects a live VIDEO with no duration or no size', async () => {
      await expect(
        adminPrisma.progressPhoto.create({ data: videoRow({ durationMs: null }) }),
      ).rejects.toThrow();
      await expect(
        adminPrisma.progressPhoto.create({ data: videoRow({ id: fid('vid2'), sizeBytes: null }) }),
      ).rejects.toThrow();
    });

    it('rejects a duration outside 1..45s', async () => {
      await expect(
        adminPrisma.progressPhoto.create({ data: videoRow({ id: fid('dur1'), durationMs: 999 }) }),
      ).rejects.toThrow();
      await expect(
        adminPrisma.progressPhoto.create({
          data: videoRow({ id: fid('dur2'), durationMs: 45_001 }),
        }),
      ).rejects.toThrow();
    });

    it('rejects a size above the 14MiB cap', async () => {
      await expect(
        adminPrisma.progressPhoto.create({
          data: videoRow({ id: fid('big'), sizeBytes: MAX_VIDEO_BYTES + 1 }),
        }),
      ).rejects.toThrow();
    });

    it('accepts a complete live VIDEO at both boundaries', async () => {
      const created = await adminPrisma.progressPhoto.create({
        data: videoRow({ id: fid('ok'), durationMs: 45_000, sizeBytes: MAX_VIDEO_BYTES }),
      });
      expect(created.kind).toBe('VIDEO');
      await adminPrisma.progressPhoto.delete({ where: { id: created.id } });
    });

    it('rejects a keyless row that is not archived', async () => {
      await expect(
        adminPrisma.progressPhoto.create({
          data: {
            id: fid('nokey'),
            unitId: UNIT_A,
            phaseId: PHASE_A,
            organizationId: ORG_A,
            key: null,
            mimeType: 'image/jpeg',
            filename: 'x.jpg',
            caption: 'keyless',
            takenAt: new Date('2026-11-23T09:00:00Z'),
          },
        }),
      ).rejects.toThrow();
    });

    it('accepts an archived tombstone with no keys and no video fields', async () => {
      const tomb = await adminPrisma.progressPhoto.create({
        data: {
          id: fid('tomb'),
          unitId: UNIT_A,
          phaseId: PHASE_A,
          organizationId: ORG_A,
          kind: 'VIDEO',
          key: null,
          posterKey: null,
          durationMs: null,
          sizeBytes: null,
          archivedAt: new Date('2026-11-23T10:00:00Z'),
          mimeType: 'video/mp4',
          filename: 'gone.mp4',
          caption: 'purged',
          takenAt: new Date('2026-11-23T09:00:00Z'),
        },
      });
      expect(tomb.key).toBeNull();
      await adminPrisma.progressPhoto.delete({ where: { id: tomb.id } });
    });

    it('defaults kind to PHOTO so the existing insert path is unchanged', async () => {
      const photo = await adminPrisma.progressPhoto.create({
        data: {
          id: fid('photo'),
          unitId: UNIT_A,
          phaseId: PHASE_A,
          organizationId: ORG_A,
          key: 'progress/suv/photo.jpg',
          mimeType: 'image/jpeg',
          filename: 'photo.jpg',
          caption: 'plain photo',
          takenAt: new Date('2026-11-23T09:00:00Z'),
        },
      });
      expect(photo.kind).toBe('PHOTO');
      await adminPrisma.progressPhoto.delete({ where: { id: photo.id } });
    });
  });

  // ── StorageUsage ─────────────────────────────────────────────────────────

  describe('StorageUsage', () => {
    it('rejects a second ledger row for the same org', async () => {
      await adminPrisma.storageUsage.create({ data: { organizationId: ORG_A, usedBytes: 0n } });
      await expect(
        adminPrisma.storageUsage.create({ data: { organizationId: ORG_A, usedBytes: 0n } }),
      ).rejects.toThrow();
    });

    it('lets a member read and advance the org ledger', async () => {
      const read = await withRlsContext(prisma, engA, (tx) =>
        tx.storageUsage.findMany({ where: { organizationId: ORG_A } }),
      );
      expect(read).toHaveLength(1);

      const after = await withRlsContext(prisma, engA, (tx) =>
        tx.storageUsage.update({
          where: { organizationId: ORG_A },
          data: { usedBytes: 4_000_000n },
        }),
      );
      expect(after.usedBytes).toBe(4_000_000n);

      await adminPrisma.storageUsage.update({
        where: { organizationId: ORG_A },
        data: { usedBytes: 0n },
      });
    });

    it("does not leak another org's ledger", async () => {
      await adminPrisma.storageUsage.create({ data: { organizationId: ORG_B, usedBytes: 999n } });
      const seen = await withRlsContext(prisma, engA, (tx) =>
        tx.storageUsage.findMany({ where: { organizationId: ORG_B } }),
      );
      expect(seen).toHaveLength(0);
    });

    it('lets the canonical cron pair move the ledger and rejects a forged role', async () => {
      const byCron = await withRlsContext(prisma, cronA, (tx) =>
        tx.storageUsage.update({ where: { organizationId: ORG_A }, data: { usedBytes: 1n } }),
      );
      expect(byCron.usedBytes).toBe(1n);

      // Role CRON_SERVICE with a real user id: the cron arm requires the
      // sentinel pair, and the staff arm excludes CRON_SERVICE, so this is
      // denied by both.
      await expect(
        withRlsContext(prisma, cronForge, (tx) =>
          tx.storageUsage.update({ where: { organizationId: ORG_A }, data: { usedBytes: 2n } }),
        ),
      ).rejects.toThrow();

      await adminPrisma.storageUsage.update({
        where: { organizationId: ORG_A },
        data: { usedBytes: 0n },
      });
    });

    it('denies a CUSTOMER writing the ledger, even in the same org', async () => {
      // The ledger is the enforcement point for the per-org video cap. A buyer
      // who can advance usedBytes can hand themselves unlimited storage, so the
      // write arms are staff-only. This is the case the step-1 policies missed.
      const before = await adminPrisma.storageUsage.findUniqueOrThrow({
        where: { organizationId: ORG_A },
      });
      await expect(
        withRlsContext(prisma, custA, (tx) =>
          tx.storageUsage.update({
            where: { organizationId: ORG_A },
            data: { usedBytes: 999_999n },
          }),
        ),
      ).rejects.toThrow();
      const after = await adminPrisma.storageUsage.findUniqueOrThrow({
        where: { organizationId: ORG_A },
      });
      expect(after.usedBytes).toBe(before.usedBytes);
    });
  });

  // ── SiteUpdateDelivery ───────────────────────────────────────────────────

  describe('SiteUpdateDelivery', () => {
    const delivery = (batchId: string, unitId = UNIT_A, org = ORG_A) => ({
      organizationId: org,
      batchId,
      unitId,
    });

    it('lets the assigned engineer write a delivery row for their villa', async () => {
      const row = await withRlsContext(prisma, engA, (tx) =>
        tx.siteUpdateDelivery.create({ data: delivery(BATCH_MEMBER) }),
      );
      expect(row.status).toBe('PENDING');

      const own = await withRlsContext(prisma, engA, (tx) =>
        tx.siteUpdateDelivery.findMany({ where: { batchId: BATCH_MEMBER } }),
      );
      expect(own).toHaveLength(1);
    });

    it('denies an engineer with no team membership', async () => {
      await expect(
        withRlsContext(prisma, engN, (tx) =>
          tx.siteUpdateDelivery.create({ data: delivery(fid('btcn')) }),
        ),
      ).rejects.toThrow();

      const seen = await withRlsContext(prisma, engN, (tx) =>
        tx.siteUpdateDelivery.findMany({ where: { batchId: BATCH_MEMBER } }),
      );
      expect(seen).toHaveLength(0);
    });

    it('denies the assigned engineer a villa that is not theirs', async () => {
      await expect(
        withRlsContext(prisma, engA, (tx) =>
          tx.siteUpdateDelivery.create({ data: delivery(fid('btcu'), UNIT_FREE) }),
        ),
      ).rejects.toThrow();
    });

    it('denies a whole other org even with a real unit id', async () => {
      const seen = await withRlsContext(
        prisma,
        { userId: ADM_A, role: 'ADMIN' as const, organizationId: ORG_B },
        (tx) => tx.siteUpdateDelivery.findMany({ where: { organizationId: ORG_A } }),
      );
      expect(seen).toHaveLength(0);
    });

    it('lets ADMIN read the org and delete a bad batch, but not a MANAGER', async () => {
      const asAdmin = await withRlsContext(prisma, admA, (tx) =>
        tx.siteUpdateDelivery.findMany({ where: { batchId: BATCH_MEMBER } }),
      );
      expect(asAdmin).toHaveLength(1);

      const mgrDelete = await withRlsContext(prisma, mgrA, (tx) =>
        tx.siteUpdateDelivery.deleteMany({ where: { batchId: BATCH_MEMBER } }),
      );
      expect(mgrDelete.count).toBe(0);

      const adminDelete = await withRlsContext(prisma, admA, (tx) =>
        tx.siteUpdateDelivery.deleteMany({ where: { batchId: BATCH_MEMBER } }),
      );
      expect(adminDelete.count).toBe(1);
    });

    it('lets the cron pair claim a PENDING row and flip it SENT', async () => {
      await adminPrisma.siteUpdateDelivery.create({ data: delivery(BATCH_CRON) });
      const claimed = await withRlsContext(prisma, cronA, (tx) =>
        tx.siteUpdateDelivery.update({
          where: { organizationId_batchId: { organizationId: ORG_A, batchId: BATCH_CRON } },
          data: { status: 'SENT', attempts: { increment: 1 }, sentAt: new Date() },
        }),
      );
      expect(claimed.status).toBe('SENT');
      expect(claimed.attempts).toBe(1);
    });

    it('rejects the forged cron pair on a delivery row', async () => {
      await adminPrisma.siteUpdateDelivery.create({ data: delivery(BATCH_FORGE) });
      await expect(
        withRlsContext(prisma, cronForge, (tx) =>
          tx.siteUpdateDelivery.update({
            where: { organizationId_batchId: { organizationId: ORG_A, batchId: BATCH_FORGE } },
            data: { status: 'SENT' },
          }),
        ),
      ).rejects.toThrow();
    });

    it('denies a CUSTOMER claiming or writing a delivery row', async () => {
      await adminPrisma.siteUpdateDelivery.create({ data: delivery(fid('btccu')) });

      // Insert: the membership join alone would not stop a buyer who happens to
      // sit on a team row; the role guard is what does.
      await expect(
        withRlsContext(prisma, custA, (tx) =>
          tx.siteUpdateDelivery.create({ data: delivery(fid('btccx')) }),
        ),
      ).rejects.toThrow();

      // Update: marking a note SENT is a staff act with a WhatsApp consequence.
      await expect(
        withRlsContext(prisma, custA, (tx) =>
          tx.siteUpdateDelivery.update({
            where: { organizationId_batchId: { organizationId: ORG_A, batchId: fid('btccu') } },
            data: { status: 'SENT' },
          }),
        ),
      ).rejects.toThrow();

      const still = await adminPrisma.siteUpdateDelivery.findUniqueOrThrow({
        where: { organizationId_batchId: { organizationId: ORG_A, batchId: fid('btccu') } },
      });
      expect(still.status).toBe('PENDING');
    });
  });

  // ── Unit.handoverCompletedAt ─────────────────────────────────────────────

  it('leaves handoverCompletedAt null so nothing is purged on a guess', async () => {
    const unit = await adminPrisma.unit.findUniqueOrThrow({ where: { id: UNIT_A } });
    expect(unit.handoverCompletedAt).toBeNull();
  });
});
