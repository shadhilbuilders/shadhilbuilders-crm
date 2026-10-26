// ────────────────────────────────────────────────────────────────────────────
// Issue #7 slice 1 - Customer progress RLS (DB-first isolation tests)
// ────────────────────────────────────────────────────────────────────────────
// Acceptance criteria 1 + 3 of docs/specs/SPEC-customer-progress-slice-1-body.md:
//
//   1. ENGINEER isolation (own-project photos only; denied on sales tables)
//      + photo-lead boundary (non-lead cannot edit another member's photo;
//      photo-lead and ADMIN can).
//   3. Direct RLS reads under an ENGINEER context on Lead/Message/Booking
//      return EMPTY SET (exact: length 0, no throw) - pinning the
//      permissive-by-absence semantics the service layer must not mistake
//      for "no rows".
//
// protects= the migration's policy set (20261026160800) behaves exactly as
//           the spec matrix; fails_when= any policy grants beyond the matrix
//           or denies a member; no_claim= green does NOT prove the
//           application-layer 403s (apps/backend customer-progress module
//           tests own those) nor the web UI.
//
// Same fixture contract as rls-isolation.test.ts: owner-role client from
// DIRECT_DATABASE_URL for seeding, withRlsContext for the probes under
// test, real cuid2 ids, idempotent upserts. Reuses the RLS matrix's two-org
// fixture ids where overlapping (project/phase/unit/team A) so the suites
// share a fixture world rather than inventing a second one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../src/index';
import { withRlsContext } from '../src/rls';
import { createDirectPrismaClient } from '../src/test-db-isolation';

import { DATABASE_AVAILABLE } from './setup';

const adminPrisma = createDirectPrismaClient();

// Same org as the RLS matrix fixture (the seeded demo org).
const ORG_ID = 'ceid01lpfe1esm8jwsxid41k28';

// Real cuid2s (repo rule: no hyphenated slugs).
const TEAM_A_ID = 'vee900fbu1sfhnbtht9da9hh'; // shared with the RLS matrix
const TEAM_B_ID = 'm1afmaqirrc5esc2b8ow68yh';

const PROJ_A_ID = 'u83jbfz0bm340q1qaj17xoe3'; // shared with the RLS matrix
const PROJ_B_ID = 'h0wgdy2d32ax3eyl0r55db5e';

// Phases are THIS suite's own rows (the matrix fixture owns phases on these
// projects with FA-/FB- unit numbers; a unit-number collision on the
// (phaseId, unitNumber) unique key would break the matrix fixture's
// upserts). Distinct ids + 'PA-ENG-*' numbers keep the two suites disjoint.
const PHASE_A_ID = 'c1mg1xq8xv2xkq0n1rd5t8eb';
const PHASE_B_ID = 'c1mg1xq8xv2xkq0n1rd5t8ec';

const ENG_A_ID = 'cq9kvh1p2m7n3r8s4t5u6vwa'; // engineer on team A
const ENG_B_ID = 'cq9kvh1p2m7n3r8s4t5u6vwb'; // engineer on team B (sibling org surface)
const ENG_N_ID = 'cq9kvh1p2m7n3r8s4t5u6vwc'; // engineer with NO team membership
const PL_A_ID = 'cq9kvh1p2m7n3r8s4t5u6vwd'; // photo-lead (manager of team A, no TeamMember row)

const PHOTO_SELF_ID = 'cq9kvh1p2m7n3r8s4t5u6vwe'; // eng A's own photo
const PHOTO_OTHER_ID = 'cq9kvh1p2m7n3r8s4t5u6vwf'; // eng B's photo (same unit - cross-project probe)
const PHOTO_ADMIN_ID = 'cq9kvh1p2m7n3r8s4t5u6vwg'; // photo createdBy eng-A, edited by photo-lead

// ── Fixture ────────────────────────────────────────────────────────────────

async function buildFixture(): Promise<void> {
  // Engineers. eng-A: team A member (project A). eng-B: team B member
  // (project B). eng-N: no membership. PL-A: manager of team A via
  // managerId arm (no TeamMember row) + ProjectStaffRole PHOTO_LEAD.
  const users = [
    { id: ENG_A_ID, role: 'ENGINEER' as const, email: 'eng-a@fixture.x' },
    { id: ENG_B_ID, role: 'ENGINEER' as const, email: 'eng-b@fixture.x' },
    { id: ENG_N_ID, role: 'ENGINEER' as const, email: 'eng-n@fixture.x' },
    { id: PL_A_ID, role: 'MANAGER' as const, email: 'pl-a@fixture.x' },
  ];
  for (const u of users) {
    await adminPrisma.user.upsert({
      where: { id: u.id },
      update: { role: u.role },
      create: {
        id: u.id,
        email: u.email,
        name: u.id,
        role: u.role,
        emailVerified: true,
        organizationId: ORG_ID,
      },
    });
  }

  // Teams come from the shared RLS-matrix fixture world; ensure both exist
  // (this suite may run standalone against a fresh test DB) with team A
  // managed by PL-A so the managerId arm has a real row.
  await adminPrisma.team.upsert({
    where: { id: TEAM_A_ID },
    update: { managerId: PL_A_ID },
    create: { id: TEAM_A_ID, name: 'Fixture A', managerId: PL_A_ID, organizationId: ORG_ID },
  });
  await adminPrisma.team.upsert({
    where: { id: TEAM_B_ID },
    update: {},
    create: { id: TEAM_B_ID, name: 'Fixture B', organizationId: ORG_ID },
  });

  // Projects + phases + units (the matrix fixture world may not exist when
  // this suite runs standalone on a fresh test DB).
  await adminPrisma.project.upsert({
    where: { id: PROJ_A_ID },
    update: {},
    create: { id: PROJ_A_ID, name: 'Fixture Project A', slug: PROJ_A_ID, address: '123 A', organizationId: ORG_ID },
  });
  await adminPrisma.project.upsert({
    where: { id: PROJ_B_ID },
    update: {},
    create: { id: PROJ_B_ID, name: 'Fixture Project B', slug: PROJ_B_ID, address: '123 B', organizationId: ORG_ID },
  });
  await adminPrisma.phase.upsert({
    where: { id: PHASE_A_ID },
    update: {},
    create: { id: PHASE_A_ID, projectId: PROJ_A_ID, name: 'Phase A', organizationId: ORG_ID },
  });
  await adminPrisma.phase.upsert({
    where: { id: PHASE_B_ID },
    update: {},
    create: { id: PHASE_B_ID, projectId: PROJ_B_ID, name: 'Phase B', organizationId: ORG_ID },
  });
  for (const [unitId, phaseId, num] of [
    ['cq9kvh1p2m7n3r8s4t5u6vwi', PHASE_A_ID, 'PA-ENG-001'],
    ['cq9kvh1p2m7n3r8s4t5u6vwj', PHASE_B_ID, 'PB-ENG-001'],
  ] as const) {
    await adminPrisma.unit.upsert({
      where: { id: unitId },
      update: {},
      create: {
        id: unitId,
        phaseId,
        unitNumber: num,
        bhk: 3,
        buildupSqft: '1000.00',
        pricePerSqft: '10000.00',
        price: '10000000.00',
        organizationId: ORG_ID,
      },
    });
  }

  // ProjectTeam links: team A -> project A, team B -> project B.
  await adminPrisma.projectTeam.upsert({
    where: { projectId_teamId: { projectId: PROJ_A_ID, teamId: TEAM_A_ID } },
    update: {},
    create: { projectId: PROJ_A_ID, teamId: TEAM_A_ID, organizationId: ORG_ID },
  });
  await adminPrisma.projectTeam.upsert({
    where: { projectId_teamId: { projectId: PROJ_B_ID, teamId: TEAM_B_ID } },
    update: {},
    create: { projectId: PROJ_B_ID, teamId: TEAM_B_ID, organizationId: ORG_ID },
  });

  // eng-A membership on team A. eng-B already has a team-B row from the
  // matrix fixture; ensure it (idempotent).
  await adminPrisma.teamMember.upsert({
    where: { userId_teamId: { userId: ENG_A_ID, teamId: TEAM_A_ID } },
    update: {},
    create: { userId: ENG_A_ID, teamId: TEAM_A_ID, organizationId: ORG_ID },
  });
  await adminPrisma.teamMember.upsert({
    where: { userId_teamId: { userId: ENG_B_ID, teamId: TEAM_B_ID } },
    update: {},
    create: { userId: ENG_B_ID, teamId: TEAM_B_ID, organizationId: ORG_ID },
  });

  // Photo-lead grant on project A only (never project B - sibling-project
  // leak is the thing the per-project table exists to prevent).
  await adminPrisma.projectStaffRole.upsert({
    where: { userId_projectId_kind: { userId: PL_A_ID, projectId: PROJ_A_ID, kind: 'PHOTO_LEAD' } },
    update: {},
    create: { userId: PL_A_ID, projectId: PROJ_A_ID, kind: 'PHOTO_LEAD', organizationId: ORG_ID },
  });

  // Photos: eng-A's own on unit A (project A) and eng-B's on unit B
  // (project B). Both under the same org - the boundary under test is the
  // project-membership join, not the org gate. Units here are THIS suite's
  // own fixture rows (created above), not the matrix fixture's.
  for (const p of [
    { id: PHOTO_SELF_ID, unitId: 'cq9kvh1p2m7n3r8s4t5u6vwi', phaseId: PHASE_A_ID, createdBy: ENG_A_ID },
    { id: PHOTO_OTHER_ID, unitId: 'cq9kvh1p2m7n3r8s4t5u6vwj', phaseId: PHASE_B_ID, createdBy: ENG_B_ID },
  ]) {
    await adminPrisma.progressPhoto.upsert({
      where: { id: p.id },
      update: { createdBy: p.createdBy },
      create: {
        id: p.id,
        unitId: p.unitId,
        phaseId: p.phaseId,
        organizationId: ORG_ID,
        key: `progress/${p.id}.jpg`,
        mimeType: 'image/jpeg',
        filename: `${p.id}.jpg`,
        caption: `${p.id} caption`,
        takenAt: new Date('2026-10-26T10:00:00Z'),
        createdBy: p.createdBy,
      },
    });
  }
}

// ── Contexts ───────────────────────────────────────────────────────────────

const engA = { userId: ENG_A_ID, role: 'ENGINEER' as const, organizationId: ORG_ID };
const engN = { userId: ENG_N_ID, role: 'ENGINEER' as const, organizationId: ORG_ID };
const engB = { userId: ENG_B_ID, role: 'ENGINEER' as const, organizationId: ORG_ID };
const plA = { userId: PL_A_ID, role: 'MANAGER' as const, organizationId: ORG_ID };
const admin = { userId: 'admin-fixture', role: 'ADMIN' as const, organizationId: ORG_ID };

const maybe = DATABASE_AVAILABLE ? describe : describe.skip;

// ── Tests ──────────────────────────────────────────────────────────────────

maybe('Customer progress RLS (issue #7 slice 1)', () => {
  beforeAll(async () => {
    await buildFixture();
  });

  afterAll(async () => {
    // Photos are the only rows this suite creates beyond the shared fixture
    // world's pre-existing rows (units/users/teams are shared and stay).
    await adminPrisma.progressPhoto.deleteMany({
      where: { id: { in: [PHOTO_SELF_ID, PHOTO_OTHER_ID, PHOTO_ADMIN_ID] } },
    });
    await adminPrisma.projectStaffRole.deleteMany({
      where: { userId: { in: [PL_A_ID] } },
    });
  });

  it('protects= ENGINEER sees own-project photos; fails_when= cross-project rows leak', async () => {
    const own = await withRlsContext(prisma, engA, async (tx) =>
      tx.progressPhoto.findMany({ where: { id: PHOTO_SELF_ID } }),
    );
    expect(own).toHaveLength(1);

    const cross = await withRlsContext(prisma, engA, async (tx) =>
      tx.progressPhoto.findMany({ where: { id: PHOTO_OTHER_ID } }),
    );
    // eng-A is NOT a member of project B (team B) - the sibling project in
    // the same org. Permissive-by-absence: empty array, no throw.
    expect(cross).toHaveLength(0);
  });

  it('protects= non-member ENGINEER sees nothing; fails_when= org-wide visibility', async () => {
    const rows = await withRlsContext(prisma, engN, async (tx) =>
      tx.progressPhoto.findMany({ where: { id: { in: [PHOTO_SELF_ID, PHOTO_OTHER_ID] } } }),
    );
    expect(rows).toHaveLength(0);
    // Dependency reads are also member-scoped (never org-wide for engineers).
    const units = await withRlsContext(prisma, engN, async (tx) =>
      tx.unit.findMany({ where: { unitNumber: 'PA-ENG-001' } }),
    );
    expect(units).toHaveLength(0);
  });

  it('protects= sales-table deny is EMPTY SET without throwing (AC3 exact)', async () => {
    // The pin: RLS denies silently. A test asserting `.throws` here would
    // encode the WRONG semantics - the service layer must translate this
    // emptiness into its own 403, so green must prove emptiness specifically.
    const leads = await withRlsContext(prisma, engA, async (tx) => tx.lead.findMany({}));
    expect(leads).toHaveLength(0);
    const messages = await withRlsContext(prisma, engA, async (tx) => tx.message.findMany({}));
    expect(messages).toHaveLength(0);
    const bookings = await withRlsContext(prisma, engA, async (tx) => tx.booking.findMany({}));
    expect(bookings).toHaveLength(0);
  });

  it('protects= member INSERT of own photo; fails_when= forging another creator', async () => {
    const inserted = await withRlsContext(prisma, engA, async (tx) =>
      tx.progressPhoto.create({
        data: {
          id: PHOTO_ADMIN_ID,
          unitId: (await tx.unit.findFirst({ where: { id: 'cq9kvh1p2m7n3r8s4t5u6vwi' }, select: { id: true } }))!.id,
          phaseId: PHASE_A_ID,
          organizationId: ORG_ID,
          key: `progress/${PHOTO_ADMIN_ID}.jpg`,
          mimeType: 'image/jpeg',
          filename: `${PHOTO_ADMIN_ID}.jpg`,
          caption: 'probe insert',
          takenAt: new Date('2026-10-26T11:00:00Z'),
          createdBy: ENG_A_ID,
        },
      }),
    );
    expect(inserted.createdBy).toBe(ENG_A_ID);

    // WITH CHECK binds createdBy to app.user_id for the member arm: forging
    // another user's creator id must be rejected by RLS (the service never
    // accepts client-supplied creator ids anyway; this pins the DB wall).
    await expect(
      withRlsContext(prisma, engA, async (tx) =>
        tx.progressPhoto.create({
          data: {
            id: 'cq9kvh1p2m7n3r8s4t5u6vwh',
            unitId: (await tx.unit.findFirst({ where: { id: 'cq9kvh1p2m7n3r8s4t5u6vwi' }, select: { id: true } }))!.id,
            phaseId: PHASE_A_ID,
            organizationId: ORG_ID,
            key: `progress/forge.jpg`,
            mimeType: 'image/jpeg',
            filename: 'forge.jpg',
            caption: 'forge',
            takenAt: new Date('2026-10-26T11:05:00Z'),
            createdBy: ENG_B_ID,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('protects= creator can edit own photo; fails_when= non-lead edits another member photo', async () => {
    // eng-A edits own photo: allowed (creator arm).
    const own = await withRlsContext(prisma, engA, async (tx) =>
      tx.progressPhoto.update({ where: { id: PHOTO_SELF_ID }, data: { caption: 'self-edit' } }),
    );
    expect(own.caption).toBe('self-edit');

    // eng-A on eng-B's photo (different project, not creator, no lead role):
    // the UPDATE matches zero rows under RLS - Prisma surfaces as P2025.
    await expect(
      withRlsContext(prisma, engA, async (tx) =>
        tx.progressPhoto.update({ where: { id: PHOTO_OTHER_ID }, data: { caption: 'hijack' } }),
      ),
    ).rejects.toThrow();

    // eng-N (no membership): also zero rows.
    await expect(
      withRlsContext(prisma, engN, async (tx) =>
        tx.progressPhoto.update({ where: { id: PHOTO_SELF_ID }, data: { caption: 'hijack' } }),
      ),
    ).rejects.toThrow();
  });

  it('protects= photo-lead (managerId arm) edits another member photo; fails_when= sibling-project leak', async () => {
    // PL-A manages team A which links project A; PL-A holds PHOTO_LEAD on
    // project A only. Editing eng-A's photo (project A) is the grant.
    const edited = await withRlsContext(prisma, plA, async (tx) =>
      tx.progressPhoto.update({ where: { id: PHOTO_ADMIN_ID }, data: { caption: 'lead-edit' } }),
    );
    expect(edited.caption).toBe('lead-edit');

    // Sibling project: PL-A has NO ProjectStaffRole on project B. Without
    // the per-project table this would leak through team A membership.
    await expect(
      withRlsContext(prisma, plA, async (tx) =>
        tx.progressPhoto.update({ where: { id: PHOTO_OTHER_ID }, data: { caption: 'leak' } }),
      ),
    ).rejects.toThrow();
  });

  it('protects= ADMIN org-wide read+edit; fails_when= photo-lead endpoint forgery', async () => {
    const rows = await withRlsContext(prisma, admin, async (tx) =>
      tx.progressPhoto.findMany({ where: { id: { in: [PHOTO_SELF_ID, PHOTO_OTHER_ID] } } }),
    );
    expect(rows).toHaveLength(2);

    const edited = await withRlsContext(prisma, admin, async (tx) =>
      tx.progressPhoto.update({ where: { id: PHOTO_OTHER_ID }, data: { caption: 'admin-edit' } }),
    );
    expect(edited.caption).toBe('admin-edit');

    // ADMIN manages the authority table org-wide; a MANAGER (even a photo
    // lead) must not grant the role to anyone.
    await expect(
      withRlsContext(prisma, plA, async (tx) =>
        tx.projectStaffRole.create({
          data: { userId: ENG_N_ID, projectId: PROJ_B_ID, kind: 'PHOTO_LEAD', organizationId: ORG_ID },
        }),
      ),
    ).rejects.toThrow();
  });

  it('protects= creator label helper; fails_when= cross-org or no-context reads', async () => {
    // Member context: label resolves + photo-lead flag false (eng-A has no
    // PHOTO_LEAD row on project A).
    const label = await withRlsContext(prisma, engA, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ creator_name: string | null; creator_is_photo_lead: boolean | null }>>`
        SELECT creator_name, creator_is_photo_lead FROM progress_photo_creator_label(${PHOTO_SELF_ID})`;
      return rows;
    });
    expect(label).toHaveLength(1);
    expect(label[0].creator_name).toBeTruthy();
    expect(label[0].creator_is_photo_lead).toBe(false);

    // Photo-lead flag flips after a grant (the endpoint's write path).
    await adminPrisma.projectStaffRole.create({
      data: { userId: ENG_B_ID, projectId: PROJ_B_ID, kind: 'PHOTO_LEAD', organizationId: ORG_ID },
    });
    try {
      const flagged = await withRlsContext(prisma, engB, async (tx) => {
        return tx.$queryRaw<Array<{ creator_is_photo_lead: boolean | null }>>`
          SELECT creator_is_photo_lead FROM progress_photo_creator_label(${PHOTO_OTHER_ID})`;
      });
      expect(flagged[0].creator_is_photo_lead).toBe(true);
    } finally {
      await adminPrisma.projectStaffRole.deleteMany({
        where: { userId: ENG_B_ID, kind: 'PHOTO_LEAD' },
      });
    }

    // Non-member: invisible photo -> (NULL, NULL). The helper returns no
    // rows for a caller who cannot read the photo (RETURN without
    // RETURN QUERY). Assert the exact empty contract - a leaked creator
    // name here would be a cross-membership information leak.
    const nullLabel = await withRlsContext(prisma, engN, async (tx) =>
      tx.$queryRaw<Array<{ creator_name: string | null }>>`
        SELECT creator_name FROM progress_photo_creator_label(${PHOTO_SELF_ID})`,
    );
    expect(nullLabel).toHaveLength(0);
  });

  it('protects= dependency reads stay member-scoped for ENGINEER; fails_when= whole org leaks', async () => {
    // eng-A sees unit A (own project) but not unit B (sibling project).
    const units = await withRlsContext(prisma, engA, async (tx) =>
      tx.unit.findMany({ where: { unitNumber: { in: ['PA-ENG-001', 'PB-ENG-001'] } } }),
    );
    expect(units.map((u) => u.unitNumber).sort()).toEqual(['PA-ENG-001']);

    const phases = await withRlsContext(prisma, engA, async (tx) =>
      tx.phase.findMany({ where: { id: { in: [PHASE_A_ID, PHASE_B_ID] } } }),
    );
    expect(phases).toHaveLength(1);

    const projects = await withRlsContext(prisma, engA, async (tx) =>
      tx.project.findMany({ where: { id: { in: [PROJ_A_ID, PROJ_B_ID] } } }),
    );
    expect(projects).toHaveLength(1);
  });
});