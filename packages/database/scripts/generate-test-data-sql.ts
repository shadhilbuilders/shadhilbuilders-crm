// ────────────────────────────────────────────────────────────────────────────
// Bulk test-data DATASET for the test tenant (test@shadhilbuilders.in)
// ────────────────────────────────────────────────────────────────────────────
// WHY: the test tenant ("Shadhil Test" / slug `test`) needs >100 rows per
// scenario (leads, bookings, users, visits) so every list, filter, sort,
// pagination, dashboard counter and role-scoped surface can be exercised
// against the real deployment - not a 6-row shell.
//
// THIS FILE IS THE SINGLE SOURCE OF THE ROWS. It has two consumers and
// restates the data for neither:
//   1. `seed:test` (scripts/seed-test-user.ts) imports buildTestDataStatements()
//      and executes them through Prisma.
//   2. `seed:test:sql` (this file, run directly) renders the same statements to
//      scripts/seed-test-user.sql, for the psql-on-VPS path where no local deps,
//      SSH tunnel or container source sync are available.
// Adding a table means editing the dataset here - never one consumer only.
//
// IDEMPOTENT: every row has a DETERMINISTIC id derived from a stable seed
// (`detId()`), and every INSERT carries ON CONFLICT DO UPDATE, so re-running
// resets the test data instead of duplicating it. Verified by running the seed
// repeatedly and diffing the row counts.
//
// ISOLATION: every row is scoped to TEST_ORG_ID. The real org is never touched.
// The one-OWNER-per-org rule (partial unique index) is respected: the 121 new
// staff users are MANAGER / SALES_EXEC / TELECALLER / ADMIN - never OWNER.
//
// SAFETY: both paths write with the migration/owner role (`shadhil`), which is
// superuser + BYPASSRLS on this deployment, so RLS is not consulted for these
// provisioning writes.
//
// Usage:
//   pnpm --filter @shadhil/database seed:test        # apply via Prisma
//   pnpm --filter @shadhil/database seed:test:sql    # regenerate the .sql
//   ... seed:test:sql -- --out /tmp/x.sql            # custom output path
// ────────────────────────────────────────────────────────────────────────────
import { createHash, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ── Deterministic id derivation ──────────────────────────────────────────────
// cuid2 shape: 24 chars, lowercase [a-z0-9], first char a letter. zod v4's
// z.cuid2() is /^[0-9a-z]+$/, so this satisfies every id validator in the app
// (route params, DTOs) while staying stable across generator runs - which is
// what makes the upsert-by-id idempotent. (The repo's src/seed.ts uses fixed,
// pre-generated cuid2 constants for the same reason.)
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
function detId(seed: string): string {
  const h = createHash('sha256').update(`shadhil-test-data::${seed}`).digest();
  let out = LETTERS[h[24]! % 26]!;
  for (let i = 0; i < 23; i++) out += ALPHABET[h[i]! % 36]!;
  return out;
}

// ── Test tenant identity (mirrors scripts/seed-test-user.{ts,sql}) ───────────
const ORG_ID = 'k7mjd78nxvpq9vs8fqkzmfyb';
const ORG_NAME = 'Shadhil Test';
const ORG_SLUG = 'test';

const TEST_USER_ID = 't3s70wn3r1d2p4c8e9f0a1b2c'; // prod id; used only if absent
const TEST_USER_EMAIL = 'test@shadhilbuilders.in';
const TEST_USER_NAME = 'Test Owner';

// The test owner's ACTUAL id is resolved by lookup, never assumed. The row's
// upsert key is (email, organizationId) - not (id) - so on a database where the
// owner was created by a different seed its id differs from TEST_USER_ID, and
// pinning the literal would break every FK (Account.userId, Notification.userId,
// Booking.approvedById, AuditLog.userId) with
//   insert or update on table "Account" violates foreign key constraint.
// Referencing it by subquery works whether the row already exists or is created
// by the statement above.
const TEST_USER_REF = `(SELECT "id" FROM "User" WHERE "email" = ${q(TEST_USER_EMAIL)} AND "organizationId" = ${q(ORG_ID)} LIMIT 1)`;

// Every seeded staff account shares this known password (same as the test
// owner) so the operator can sign in as any role and exercise RLS.
const TEST_PASSWORD = 'Test@123456';

const PROJECT1_ID = 'uo4inf3gya03lyssknswpljq'; // Test Villas (exists)
const PROJECT1_SLUG = 'test-villas';
const PHASE_A = 'zfoou6t9bvsi5wux4amhr3lc'; // exists
const PHASE_B = 'a6bbl6uncqxwvzye5chn0dme'; // exists
const TEST_TEAM_ID = 'ne5v26zdocwey0594idqakuz'; // "Test Team" (exists)

const PROJECT2_ID = detId('project:test-greens');
const PROJECT2_SLUG = 'test-greens';
const PROJECT2_PHASE_A = detId('phase:test-greens:A');
const PROJECT2_PHASE_B = detId('phase:test-greens:B');

// ── Volumes (>100 per scenario, per the request) ─────────────────────────────
const N_TELE = 100; // TELECALLER
const N_SALES = 12; // SALES_EXEC
const N_MGR = 6; // MANAGER
const N_ADMIN = 3; // ADMIN
const N_NEW_TEAMS = 6;
const N_UNITS = 120; // 30 per phase × 4 phases
const N_LEADS = 144; // 12 × each of the 12 LeadStates
const N_BOOKINGS = 120; // one per new unit, cycling all 5 BookingStatus

// ── Password hash (deterministic salt → stable output file) ─────────────────
// Same scrypt params as packages/database/src/seed.ts (the reference impl):
// N=16384, r=16, p=1, dkLen=64, NFKC, stored "salt:key".
function hashPassword(password: string, salt: string): string {
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  }).toString('hex');
  return `${salt}:${key}`;
}
const PASSWORD_HASH = hashPassword(TEST_PASSWORD, '5hadh1l7e57da7a5a17f0ea57');

// ── Tiny SQL literal helpers ─────────────────────────────────────────────────
function q(v: string | null): string {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function n(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
/** `NOW() - INTERVAL 'x hours'` — spread rows over time for ageing counters. */
function ago(hours: number): string {
  return `NOW() - INTERVAL '${hours} hours'`;
}
function ahead(hours: number): string {
  return `NOW() + INTERVAL '${hours} hours'`;
}

// ── Name pools (deterministic, realistic) ───────────────────────────────────
const FIRST = [
  'Priya', 'Arjun', 'Kavya', 'Rahul', 'Anita', 'Sanjay', 'Deepa', 'Vikram',
  'Meera', 'Rohan', 'Sneha', 'Karthik', 'Divya', 'Ajay', 'Lakshmi', 'Suresh',
  'Nithya', 'Gopal', 'Aishwarya', 'Hari', 'Pooja', 'Naveen', 'Shalini', 'Manoj',
  'Revathi', 'Senthil', 'Bhavana', 'Praveen', 'Yamini', 'Dinesh', 'Charu',
  'Ashwin', 'Gayathri', 'Ravi', 'Nandini', 'Suresh Kumar', 'Tejaswini', 'Vignesh',
];
const LAST = [
  'Sharma', 'Reddy', 'Iyer', 'Verma', 'Krishnan', 'Patel', 'Nair', 'Singh',
  'Joshi', 'Gupta', 'Rao', 'Menon', 'Balan', 'Pillai', 'Subramanian', 'Kumar',
  'Naidu', 'Chettiar', 'Mudaliar', 'Desai',
];
function personName(i: number): string {
  return `${FIRST[i % FIRST.length]!} ${LAST[(i * 7 + 3) % LAST.length]!}`;
}

type SqlRow = string; // a single "(...)" tuple

// Every executable statement the dataset produces, in order, WITHOUT the
// file-level BEGIN/COMMIT wrapper. This is what makes the dataset a single
// source of truth: the .sql file is built from the same `insert()` calls that
// fill this array, and `seed-test-user.ts` executes this array directly through
// Prisma. Neither consumer restates the data.
const statements: string[] = [];

/** The dataset's INSERT statements, ready to execute one-by-one. */
export function buildTestDataStatements(): string[] {
  return statements;
}

function insert(
  table: string,
  cols: string[],
  rows: SqlRow[],
  conflict: { cols: string[]; update: string[] },
  chunk = 50,
): string {
  const head = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES`;
  const tail =
    `ON CONFLICT (${conflict.cols.map((c) => `"${c}"`).join(', ')}) DO UPDATE SET ` +
    conflict.update.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
  const out: string[] = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const stmt = `${head}\n${rows.slice(i, i + chunk).join(',\n')}\n${tail}`;
    out.push(`${stmt};`);
    statements.push(stmt);
  }
  return out.join('\n');
}

// ── Data model ──────────────────────────────────────────────────────────────
interface StaffUser {
  id: string;
  email: string;
  name: string;
  role: 'TELECALLER' | 'SALES_EXEC' | 'MANAGER' | 'ADMIN';
  teamId: string | null;
}

const teams: { id: string; name: string; managerId: string }[] = [];
const staff: StaffUser[] = [];

const TEAM_SUFFIX = ['North', 'South', 'East', 'West', 'Central', 'Harbour'];

// Managers first (each leads one new team).
for (let i = 0; i < N_MGR; i++) {
  const tag = `mgr${String(i + 1).padStart(2, '0')}`;
  const id = detId(`user:${tag}`);
  teams.push({
    id: detId(`team:${i}`),
    name: `Test Team ${TEAM_SUFFIX[i]!}`,
    managerId: id,
  });
  staff.push({
    id,
    email: `${tag}@shadhilbuilders.in`,
    name: `${personName(i)} (Manager)`,
    role: 'MANAGER',
    teamId: teams[i]!.id,
  });
}

// Telecallers + sales execs, round-robin across the new teams.
const tele: StaffUser[] = [];
const sales: StaffUser[] = [];
for (let i = 0; i < N_TELE; i++) {
  const tag = `tc${String(i + 1).padStart(3, '0')}`;
  const u: StaffUser = {
    id: detId(`user:${tag}`),
    email: `${tag}@shadhilbuilders.in`,
    name: `${personName(i * 3 + 1)} (Telecaller)`,
    role: 'TELECALLER',
    teamId: teams[i % N_NEW_TEAMS]!.id,
  };
  tele.push(u);
  staff.push(u);
}
for (let i = 0; i < N_SALES; i++) {
  const tag = `se${String(i + 1).padStart(2, '0')}`;
  const u: StaffUser = {
    id: detId(`user:${tag}`),
    email: `${tag}@shadhilbuilders.in`,
    name: `${personName(i * 5 + 2)} (Sales)`,
    role: 'SALES_EXEC',
    teamId: teams[i % N_NEW_TEAMS]!.id,
  };
  sales.push(u);
  staff.push(u);
}
// Admins (org-wide; no team, no TeamMember row).
const admins: StaffUser[] = [];
for (let i = 0; i < N_ADMIN; i++) {
  const tag = `adm${String(i + 1).padStart(2, '0')}`;
  const u: StaffUser = {
    id: detId(`user:${tag}`),
    email: `${tag}@shadhilbuilders.in`,
    name: `${personName(i * 11 + 4)} (Admin)`,
    role: 'ADMIN',
    teamId: null,
  };
  admins.push(u);
  staff.push(u);
}

// ── Units ───────────────────────────────────────────────────────────────────
interface UnitDef {
  id: string;
  phaseId: string;
  unitNumber: string;
  bhk: number;
  facing: string;
  sqft: number;
  pps: number; // price per sqft
}
const FACINGS = ['North', 'South', 'East', 'West'];
const units: UnitDef[] = [];
const unitSpec = [
  { phaseId: PHASE_A, prefix: 'A-3', offset: 100, count: 30 },
  { phaseId: PHASE_B, prefix: 'B-3', offset: 100, count: 30 },
  { phaseId: PROJECT2_PHASE_A, prefix: 'GA-1', offset: 100, count: 30 },
  { phaseId: PROJECT2_PHASE_B, prefix: 'GB-1', offset: 100, count: 30 },
];
for (const spec of unitSpec) {
  for (let i = 0; i < spec.count; i++) {
    const unitNumber = `${spec.prefix}${String(spec.offset + i + 1).padStart(3, '0')}`;
    const bhk = [2, 3, 4][i % 3]!;
    const sqft = 980 + bhk * 240 + (i % 7) * 35;
    const pps = 4200 + (i % 11) * 90;
    units.push({
      id: detId(`unit:${spec.phaseId}:${unitNumber}`),
      phaseId: spec.phaseId,
      unitNumber,
      bhk,
      facing: FACINGS[i % 4]!,
      sqft,
      pps,
    });
  }
}

// ── Leads ───────────────────────────────────────────────────────────────────
const LEAD_STATES = [
  'NEW', 'CONTACTED', 'VISIT_REQUESTED', 'VISIT_SCHEDULED', 'VISITED',
  'NEGOTIATION', 'BOOKING_INITIATED', 'WON', 'LOST', 'RNR',
  'RESCHEDULED', 'NO_SHOW',
] as const;
const SOURCES = ['META_AD', 'LANDING', 'REFERRAL', 'WALK_IN', 'GOOGLE', 'WEBSITE'];

interface LeadDef {
  id: string;
  name: string;
  phone: string;
  ownerId: string;
  ownerType: 'TELECALLER' | 'SALES_EXEC' | 'MANAGER';
  teamId: string;
  projectId: string;
  state: string;
  source: string;
  ageHours: number;
}
const leads: LeadDef[] = [];
for (let i = 0; i < N_LEADS; i++) {
  const roll = i % 9;
  let owner: StaffUser;
  let ownerType: LeadDef['ownerType'];
  if (roll === 0) {
    owner = sales[i % sales.length]!;
    ownerType = 'SALES_EXEC';
  } else if (i % 17 === 0) {
    const m = staff[i % N_MGR]!;
    owner = m;
    ownerType = 'MANAGER';
  } else {
    owner = tele[i % tele.length]!;
    ownerType = 'TELECALLER';
  }
  leads.push({
    id: detId(`lead:${i + 1}`),
    name: personName(i * 2 + 5),
    phone: `987653${String(i + 1).padStart(4, '0')}`,
    ownerId: owner.id,
    ownerType,
    teamId: owner.teamId!,
    projectId: i % 2 === 0 ? PROJECT1_ID : PROJECT2_ID,
    state: LEAD_STATES[i % LEAD_STATES.length]!,
    source: SOURCES[i % SOURCES.length]!,
    ageHours: 3 + i * 7,
  });
}

// ── Visit plan: one visit per lead, status chosen to match the lead's state ──
// Keeps the fixture a shape the product could actually produce (open visits
// only on schedulable leads, completed visits on post-visit leads) while still
// covering all 5 VisitStatus values so each filter chip has data.
const VISIT_PLAN: Record<string, { status: string; open: boolean }> = {
  VISIT_REQUESTED: { status: 'SCHEDULED', open: true },
  VISIT_SCHEDULED: { status: 'SCHEDULED', open: true },
  RESCHEDULED: { status: 'RESCHEDULED', open: true },
  NO_SHOW: { status: 'RESCHEDULED', open: true },
  VISITED: { status: 'COMPLETED', open: false },
  NEGOTIATION: { status: 'COMPLETED', open: false },
  BOOKING_INITIATED: { status: 'COMPLETED', open: false },
  WON: { status: 'COMPLETED', open: false },
  LOST: { status: 'NO_SHOW', open: false },
  RNR: { status: 'NO_SHOW', open: false },
  CONTACTED: { status: 'CANCELLED', open: false },
  NEW: { status: 'CANCELLED', open: false },
};

// ── Emit ─────────────────────────────────────────────────────────────────────
const parts: string[] = [];
const seen = new Set<string>();
function claim(id: string): string {
  if (seen.has(id)) throw new Error(`deterministic id collision: ${id}`);
  seen.add(id);
  return id;
}
for (const u of staff) {
  claim(u.id);
  claim(detId(`account:${u.id}`));
}
claim(detId('account:test-owner'));
for (const t of teams) claim(t.id);
for (const u of units) claim(u.id);
for (const l of leads) claim(l.id);

parts.push(`-- ============================================================================
-- Shadhil CRM - test-tenant seed data ("Shadhil Test").
-- GENERATED FILE - do not hand-edit. Source: scripts/generate-test-data-sql.ts
--   pnpm --filter @shadhil/database seed:test:sql
--
-- Target org : ${ORG_NAME} (${ORG_SLUG})  id=${ORG_ID}
-- Login      : ${TEST_USER_EMAIL} / ${TEST_PASSWORD}   (role OWNER of the test org)
-- Adds       : ${N_TELE + N_SALES + N_MGR + N_ADMIN} users, ${N_NEW_TEAMS} teams,
--              ${N_UNITS} units, ${N_LEADS} leads, ${N_BOOKINGS} bookings, plus
--              activities/messages/visits/notifications/reminders/consents/audit.
-- Idempotent : deterministic ids + ON CONFLICT DO UPDATE. Safe to re-run.
-- Run        : pnpm --filter @shadhil/database seed:test     (Prisma path)
--              psql -U shadhil -d shadhil_crm -v ON_ERROR_STOP=1 -f seed-test-user.sql
-- ============================================================================
BEGIN;
SET LOCAL row_security = off;

-- ── Organization (already exists in prod; upsert keeps the file standalone) ─
${insert(
  'Organization',
  ['id', 'name', 'slug', 'createdAt', 'updatedAt'],
  [`(${q(ORG_ID)}, ${q(ORG_NAME)}, ${q(ORG_SLUG)}, NOW(), NOW())`],
  { cols: ['id'], update: ['name', 'slug', 'updatedAt'] },
)}

-- ── Test OWNER user (exists; kept for a standalone re-provision) ────────────
${insert(
  'User',
  ['id', 'email', 'name', 'role', 'organizationId', 'emailVerified', 'mustChangePassword', 'createdAt', 'updatedAt'],
  [
    `(${q(TEST_USER_ID)}, ${q(TEST_USER_EMAIL)}, ${q(TEST_USER_NAME)}, 'OWNER'::"Role", ${q(ORG_ID)}, true, false, NOW(), NOW())`,
  ],
  {
    cols: ['email', 'organizationId'],
    update: ['name', 'role', 'organizationId', 'emailVerified', 'mustChangePassword', 'updatedAt'],
  },
)}
${insert(
  'Account',
  ['id', 'accountId', 'providerId', 'issuer', 'userId', 'password', 'createdAt', 'updatedAt'],
  [
    `(${q(detId('account:test-owner'))}, ${TEST_USER_REF}, 'credential', 'local:credential', ${TEST_USER_REF}, ${q(PASSWORD_HASH)}, NOW(), NOW())`,
  ],
  { cols: ['providerId', 'accountId'], update: ['issuer', 'userId', 'password', 'updatedAt'] },
)}

-- ── ${N_TELE + N_SALES + N_MGR} staff users (${N_TELE} telecallers, ${N_SALES} sales execs, ${N_MGR} managers) ──
${insert(
  'User',
  ['id', 'email', 'name', 'role', 'organizationId', 'emailVerified', 'mustChangePassword', 'createdAt', 'updatedAt'],
  staff
    .filter((u) => u.role !== 'ADMIN')
    .map(
      (u, i) =>
        `(${q(u.id)}, ${q(u.email)}, ${q(u.name)}, ${q(u.role)}::"Role", ${q(ORG_ID)}, true, false, ${ago(24 * 30 + i * 3)}, NOW())`,
    ),
  {
    cols: ['email', 'organizationId'],
    update: ['name', 'role', 'organizationId', 'emailVerified', 'mustChangePassword', 'updatedAt'],
  },
)}

-- ── ${N_ADMIN} admin users (org-wide; no team) ───────────────────────────────
${insert(
  'User',
  ['id', 'email', 'name', 'role', 'organizationId', 'emailVerified', 'mustChangePassword', 'createdAt', 'updatedAt'],
  admins.map(
    (u, i) =>
      `(${q(u.id)}, ${q(u.email)}, ${q(u.name)}, 'ADMIN'::"Role", ${q(ORG_ID)}, true, false, ${ago(24 * 20 + i * 5)}, NOW())`,
  ),
  {
    cols: ['email', 'organizationId'],
    update: ['name', 'role', 'organizationId', 'emailVerified', 'mustChangePassword', 'updatedAt'],
  },
)}

-- ── Credentials for every seeded staff user (password: ${TEST_PASSWORD}) ────
-- Enables signing in AS any role to exercise role-scoped screens + RLS.
${insert(
  'Account',
  ['id', 'accountId', 'providerId', 'issuer', 'userId', 'password', 'createdAt', 'updatedAt'],
  staff.map(
    (u) =>
      `(${q(detId(`account:${u.id}`))}, ${q(u.id)}, 'credential', 'local:credential', ${q(u.id)}, ${q(PASSWORD_HASH)}, NOW(), NOW())`,
  ),
  { cols: ['providerId', 'accountId'], update: ['issuer', 'userId', 'password', 'updatedAt'] },
)}

-- ── ${N_NEW_TEAMS} new teams, each led by one of the seeded managers ────────
${insert(
  'Team',
  ['id', 'name', 'managerId', 'organizationId', 'autoAssignLeads', 'createdAt'],
  teams.map((t) => `(${q(t.id)}, ${q(t.name)}, ${q(t.managerId)}, ${q(ORG_ID)}, true, ${ago(24 * 29)})`),
  { cols: ['organizationId', 'name'], update: ['name', 'managerId', 'organizationId'] },
)}

-- ── TeamMember rows (telecallers + sales execs; managers lead via Team.managerId)
${insert(
  'TeamMember',
  ['userId', 'teamId', 'organizationId', 'assignedAt', 'weight'],
  [...tele, ...sales].map(
    (u, i) => `(${q(u.id)}, ${q(u.teamId!)}, ${q(ORG_ID)}, ${ago(24 * 28)}, ${1 + (i % 3)})`,
  ),
  { cols: ['userId', 'teamId'], update: ['organizationId', 'weight'] },
)}

-- ── Projects: keep Test Villas, add Test Greens (project switcher variety) ──
${insert(
  'Project',
  ['id', 'name', 'slug', 'organizationId', 'address', 'createdAt'],
  [
    `(${q(PROJECT1_ID)}, 'Test Villas', ${q(PROJECT1_SLUG)}, ${q(ORG_ID)}, 'Test Villas, Chennai, Tamil Nadu (test data)', ${ago(24 * 40)})`,
    `(${q(PROJECT2_ID)}, 'Test Greens', ${q(PROJECT2_SLUG)}, ${q(ORG_ID)}, 'Test Greens, Chennai, Tamil Nadu (test data)', ${ago(24 * 35)})`,
  ],
  { cols: ['organizationId', 'slug'], update: ['name', 'slug', 'organizationId', 'address'] },
)}

-- ── ProjectTeam: link every test team (new + the original "Test Team") ──────
${insert(
  'ProjectTeam',
  ['projectId', 'teamId', 'organizationId', 'assignedAt'],
  [PROJECT1_ID, PROJECT2_ID].flatMap((p) =>
    [...teams.map((t) => t.id), TEST_TEAM_ID].map(
      (tid, i) => `(${q(p)}, ${q(tid)}, ${q(ORG_ID)}, ${ago(24 * 27 - i)})`,
    ),
  ),
  { cols: ['projectId', 'teamId'], update: ['organizationId'] },
)}

-- ── Phases ──────────────────────────────────────────────────────────────────
${insert(
  'Phase',
  ['id', 'projectId', 'organizationId', 'name', 'createdAt'],
  [
    `(${q(PHASE_A)}, ${q(PROJECT1_ID)}, ${q(ORG_ID)}, 'Phase A', ${ago(24 * 40)})`,
    `(${q(PHASE_B)}, ${q(PROJECT1_ID)}, ${q(ORG_ID)}, 'Phase B', ${ago(24 * 40)})`,
    `(${q(PROJECT2_PHASE_A)}, ${q(PROJECT2_ID)}, ${q(ORG_ID)}, 'Phase A', ${ago(24 * 35)})`,
    `(${q(PROJECT2_PHASE_B)}, ${q(PROJECT2_ID)}, ${q(ORG_ID)}, 'Phase B', ${ago(24 * 35)})`,
  ],
  { cols: ['id'], update: ['projectId', 'organizationId', 'name'] },
)}

-- ── ProjectOptions for Test Greens (pickers) ────────────────────────────────
${insert(
  'ProjectOption',
  ['id', 'projectId', 'organizationId', 'type', 'value', 'createdAt'],
  [
    ...FACINGS.map(
      (f, i) =>
        `(${q(detId(`option:facing:${f}`))}, ${q(PROJECT2_ID)}, ${q(ORG_ID)}, 'FACING'::"ProjectOptionType", ${q(f)}, ${ago(24 * 34 - i)})`,
    ),
    ...['2', '3', '4'].map(
      (b, i) =>
        `(${q(detId(`option:bhk:${b}`))}, ${q(PROJECT2_ID)}, ${q(ORG_ID)}, 'BHK'::"ProjectOptionType", ${q(b)}, ${ago(24 * 34 - i)})`,
    ),
  ],
  { cols: ['projectId', 'type', 'value'], update: ['organizationId', 'value'] },
)}

-- ── ${N_UNITS} units (status is trigger-derived from bookings - never seeded) ─
${insert(
  'Unit',
  ['id', 'phaseId', 'organizationId', 'unitNumber', 'bhk', 'facing', 'sqft', 'buildupSqft', 'pricePerSqft', 'price', 'createdAt'],
  units.map(
    (u) =>
      `(${q(u.id)}, ${q(u.phaseId)}, ${q(ORG_ID)}, ${q(u.unitNumber)}, ${u.bhk}, ${q(u.facing)}, ${u.sqft}, ${n(u.sqft)}, ${n(u.pps)}, ${n(Math.round(u.sqft * u.pps * 100) / 100)}, ${ago(24 * 26)})`,
  ),
  {
    cols: ['phaseId', 'unitNumber'],
    update: ['organizationId', 'bhk', 'facing', 'sqft', 'buildupSqft', 'pricePerSqft', 'price'],
  },
)}

-- ── ${N_LEADS} leads (12 per LeadState - every state populated) ─────────────
${insert(
  'Lead',
  ['id', 'name', 'phone', 'phoneE164', 'email', 'source', 'state', 'ownerId', 'ownerType', 'coOwnerId', 'teamId', 'organizationId', 'projectId', 'createdAt', 'updatedAt'],
  leads.map((l, i) => {
    const coOwner = i % 5 === 0 ? tele[(i + 7) % tele.length]! : null;
    return `(${q(l.id)}, ${q(l.name)}, ${q(l.phone)}, ${q('91' + l.phone)}, ${q(`lead${i + 1}@example.in`)}, ${q(l.source)}, ${q(l.state)}::"LeadState", ${q(l.ownerId)}, ${q(l.ownerType)}::"LeadOwnerType", ${q(coOwner?.id ?? null)}, ${q(l.teamId)}, ${q(ORG_ID)}, ${q(l.projectId)}, ${ago(l.ageHours)}, ${ago(Math.max(1, l.ageHours - 6))})`;
  }),
  {
    cols: ['phone'],
    update: ['name', 'phoneE164', 'email', 'source', 'state', 'ownerId', 'ownerType', 'coOwnerId', 'teamId', 'organizationId', 'projectId', 'updatedAt'],
  },
)}

-- ── Activities (2 per lead, cycling all 6 ActivityType) ──────────────────────
${insert(
  'Activity',
  ['id', 'leadId', 'organizationId', 'userId', 'type', 'body', 'createdAt'],
  leads.flatMap((l, i) =>
    ['CALL', 'NOTE'].map((t, k) => {
      const type = ['CALL', 'NOTE', 'STATUS_CHANGE', 'VISIT', 'EMAIL', 'ASSIGNMENT'][(i + k) % 6]!;
      const body =
        type === 'CALL'
          ? 'Called the lead, discussed pricing and floor plans.'
          : type === 'NOTE'
            ? 'Prefers an east-facing unit; budget ~1.2 Cr.'
            : type === 'STATUS_CHANGE'
              ? 'Status moved forward after the follow-up.'
              : type === 'VISIT'
                ? 'Site visit completed; liked the sample villa.'
                : type === 'EMAIL'
                  ? 'Sent the brochure and price sheet by email.'
                  : 'Lead reassigned by the manager.';
      return `(${q(detId(`activity:${l.id}:${k}`))}, ${q(l.id)}, ${q(ORG_ID)}, ${q(l.ownerId)}, ${q(type)}::"ActivityType", ${q(body)}, ${ago(Math.max(1, l.ageHours - k * 2))})`;
    }),
  ),
  { cols: ['id'], update: ['leadId', 'organizationId', 'userId', 'type', 'body'] },
)}

-- ── Messages (3 per lead: inbound customer, outbound customer, internal note) ─
${insert(
  'Message',
  ['id', 'leadId', 'organizationId', 'userId', 'direction', 'channel', 'kind', 'body', 'createdAt'],
  leads.flatMap((l) =>
    [
      `(${q(detId(`msg:${l.id}:0`))}, ${q(l.id)}, ${q(ORG_ID)}, NULL, 'IN'::"MessageDirection", 'WHATSAPP'::"MessageChannel", 'CUSTOMER'::"MessageKind", 'Hi, I saw your project listing. Can you share the price for a 3BHK?', ${ago(l.ageHours)})`,
      `(${q(detId(`msg:${l.id}:1`))}, ${q(l.id)}, ${q(ORG_ID)}, ${q(l.ownerId)}, 'OUT'::"MessageDirection", 'WHATSAPP'::"MessageChannel", 'CUSTOMER'::"MessageKind", 'Thanks for reaching out! Sharing the price sheet and floor plans now.', ${ago(Math.max(1, l.ageHours - 1))})`,
      `(${q(detId(`msg:${l.id}:2`))}, ${q(l.id)}, ${q(ORG_ID)}, ${q(l.ownerId)}, 'OUT'::"MessageDirection", 'IN_APP'::"MessageChannel", 'INTERNAL'::"MessageKind", 'Internal note: buyer is comparing two projects - follow up tomorrow.', ${ago(Math.max(1, l.ageHours - 2))})`,
    ],
  ),
  { cols: ['id'], update: ['leadId', 'organizationId', 'userId', 'direction', 'channel', 'kind', 'body'] },
)}

-- ── Site visits: one per lead (${N_LEADS}), all 5 VisitStatus, both projects ─
-- Visits are PROJECT-scoped through lead.projectId (SiteVisit has no projectId
-- column), so the mapping must reach leads in BOTH projects - an earlier
-- revision indexed leads with i*2, which is always even and put every visit
-- on Test Villas, leaving Test Greens' visits page empty.
-- The visit's status is chosen from its lead's state so the fixture is a shape
-- production could actually produce: open visits (SCHEDULED/RESCHEDULED) only
-- on leads in a schedulable state, COMPLETED on post-visit leads, and the
-- closed outcomes on the states that end up there.
-- (The API refuses a SECOND open visit on a lead; one visit per lead honours
-- that, and the id is keyed to the lead INDEX so re-runs update in place.)
${insert(
  'SiteVisit',
  ['id', 'leadId', 'organizationId', 'userId', 'scheduledFor', 'status', 'outcome', 'notes', 'reminderSentAt', 'createdAt', 'updatedAt'],
  leads.map((l, i) => {
    const plan = VISIT_PLAN[l.state] ?? { status: 'CANCELLED', open: false };
    // Open visits sit on a future business hour (the calendar is an hourly
    // grid, so a fixed hour reads properly); closed ones sit in the past.
    const dayOffset = plan.open ? 1 + (i % 21) : -(1 + (i % 28));
    const when = `date_trunc('day', NOW()) + INTERVAL '${dayOffset} days' + INTERVAL '${9 + (i % 8)} hours'`;
    const remindsAt = `date_trunc('day', NOW()) + INTERVAL '${dayOffset} days' + INTERVAL '8 hours'`;
    const outcome =
      plan.status === 'COMPLETED'
        ? 'Visit completed - customer walked the sample villa and asked for the price sheet.'
        : plan.status === 'NO_SHOW'
          ? 'Customer did not turn up and gave no prior notice.'
          : null;
    // reminderSentAt only makes sense for a visit that already happened.
    const reminderSentAt = plan.status === 'COMPLETED' || (plan.status === 'NO_SHOW' && i % 2 === 0) ? remindsAt : null;
    return `(${q(detId(`visit:${i}`))}, ${q(l.id)}, ${q(ORG_ID)}, ${q(sales[i % sales.length]!.id)}, ${when}, ${q(plan.status)}::"VisitStatus", ${q(outcome)}, ${q(`Seeded ${plan.status.toLowerCase()} visit for ${l.name}`)}, ${reminderSentAt ?? 'NULL'}, ${ago(24 * (10 + (i % 20)))}, NOW())`;
  }),
  {
    cols: ['id'],
    update: ['leadId', 'organizationId', 'userId', 'scheduledFor', 'status', 'outcome', 'notes', 'reminderSentAt', 'updatedAt'],
  },
)}

-- ── ${N_BOOKINGS} bookings - one per new unit, cycling all 5 BookingStatus ───
-- amount = listAmount = the UNIT's own price (what bookings.service.ts enforces).
-- Active statuses (HOLD/TOKEN/APPROVED) sit on distinct units, so the partial
-- unique index one_active_booking_per_unit is satisfied.
${insert(
  'Booking',
  ['id', 'leadId', 'unitId', 'organizationId', 'userId', 'amount', 'listAmount', 'tokenAmount', 'approvedById', 'status', 'notes', 'createdAt', 'updatedAt'],
  units.slice(0, N_BOOKINGS).map((u, i) => {
    const l = leads[i]!;
    const st = ['HOLD', 'TOKEN', 'APPROVED', 'REJECTED', 'CANCELLED'][i % 5]!;
    const price = Math.round(u.sqft * u.pps * 100) / 100;
    const token = st === 'TOKEN' || st === 'APPROVED' ? Math.round(price * 0.1 * 100) / 100 : null;
    const approver = st === 'APPROVED' ? TEST_USER_REF : 'NULL';
    const creator = i % 3 === 0 ? staff[i % N_TELE]!.id : sales[i % sales.length]!.id;
    return `(${q(detId(`booking:${u.id}`))}, ${q(l.id)}, ${q(u.id)}, ${q(ORG_ID)}, ${q(creator)}, ${n(price)}, ${n(price)}, ${token === null ? 'NULL' : n(token)}, ${approver}, ${q(st)}::"BookingStatus", ${q(`Seeded ${st.toLowerCase()} booking for ${u.unitNumber}`)}, ${ago(24 * (2 + i))}, NOW())`;
  }),
  { cols: ['id'], update: ['leadId', 'unitId', 'organizationId', 'userId', 'amount', 'listAmount', 'tokenAmount', 'approvedById', 'status', 'notes', 'updatedAt'] },
)}

-- ── Notifications for the test owner (>100, read + unread mix) ───────────────
${insert(
  'Notification',
  ['id', 'userId', 'organizationId', 'type', 'title', 'body', 'leadId', 'read', 'createdAt'],
  Array.from({ length: 120 }, (_, i) => {
    const l = leads[i % leads.length]!;
    const type = ['lead.assigned', 'visit.scheduled', 'booking.requested', 'chat.mention', 'lead.overdue'][i % 5]!;
    const title =
      type === 'lead.assigned'
        ? `New lead: ${l.name}`
        : type === 'visit.scheduled'
          ? `Visit scheduled with ${l.name}`
          : type === 'booking.requested'
            ? `Booking request from ${l.name}`
            : type === 'chat.mention'
              ? `You were mentioned on ${l.name}`
              : `Lead overdue: ${l.name}`;
    return `(${q(detId(`notif:${i}`))}, ${TEST_USER_REF}, ${q(ORG_ID)}, ${q(type)}, ${q(title)}, ${q('Seeded notification for production testing.')}, ${q(l.id)}, ${i % 3 === 0 ? 'true' : 'false'}, ${ago(i * 3 + 1)})`;
  }),
  { cols: ['id'], update: ['userId', 'organizationId', 'type', 'title', 'body', 'leadId', 'read'] },
)}

-- ── Reminders (all 4 ReminderType; mixed statuses) ───────────────────────────
${insert(
  'Reminder',
  ['id', 'leadId', 'organizationId', 'userId', 'type', 'status', 'scheduledFor', 'createdAt'],
  Array.from({ length: 120 }, (_, i) => {
    const l = leads[i % leads.length]!;
    const type = ['PRE_VISIT_STAFF', 'PRE_VISIT_CUSTOMER', 'RESCHEDULE_FOLLOWUP', 'NO_SHOW_STAFF'][i % 4]!;
    const status = ['SCHEDULED', 'SENT', 'CANCELLED', 'FAILED'][i % 4]!;
    return `(${q(detId(`reminder:${i}`))}, ${q(l.id)}, ${q(ORG_ID)}, ${q(l.ownerId)}, ${q(type)}::"ReminderType", ${q(status)}::"ReminderStatus", ${status === 'SCHEDULED' ? ahead(6 + i) : ago(24 + i)}, ${ago(24 * 3)})`;
  }),
  { cols: ['id'], update: ['leadId', 'organizationId', 'userId', 'type', 'status', 'scheduledFor'] },
)}

-- ── Consents (1 per lead; all 3 ConsentType) ─────────────────────────────────
${insert(
  'Consent',
  ['id', 'leadId', 'organizationId', 'consentType', 'granted', 'grantedAt', 'ipAddress', 'source', 'createdAt'],
  leads.map((l, i) => {
    const ct = ['MARKETING', 'DATA_PROCESSING', 'COMMUNICATION'][i % 3]!;
    return `(${q(detId(`consent:${l.id}`))}, ${q(l.id)}, ${q(ORG_ID)}, ${q(ct)}::"ConsentType", ${i % 4 !== 0 ? 'true' : 'false'}, ${ago(l.ageHours)}, '203.0.113.10', 'web_form', NOW())`;
  }),
  { cols: ['id'], update: ['leadId', 'organizationId', 'consentType', 'granted', 'grantedAt', 'ipAddress', 'source'] },
)}

-- ── AuditLog (>100 rows so the audit page paginates) ────────────────────────
${insert(
  'AuditLog',
  ['id', 'userId', 'organizationId', 'action', 'entityType', 'entityId', 'before', 'after', 'createdAt'],
  Array.from({ length: 120 }, (_, i) => {
    const l = leads[i % leads.length]!;
    const action = ['lead.update', 'lead.reassign', 'booking.create', 'booking.approve', 'visit.schedule'][i % 5]!;
    return `(${q(detId(`audit:${i}`))}, ${TEST_USER_REF}, ${q(ORG_ID)}, ${q(action)}, 'Lead', ${q(l.id)}, NULL, '{}'::jsonb, ${ago(i * 4 + 2)})`;
  }),
  { cols: ['id'], update: ['userId', 'organizationId', 'action', 'entityType', 'entityId', 'before', 'after'] },
)}

COMMIT;

-- ============================================================================
-- Totals written by this file
--   users ${N_TELE + N_SALES + N_MGR + N_ADMIN + 1}   teams ${N_NEW_TEAMS}   units ${N_UNITS}
--   leads ${N_LEADS}   bookings ${N_BOOKINGS}   activities ${N_LEADS * 2}   messages ${N_LEADS * 3}
--   visits ${N_LEADS}   notifications 120   reminders 120   consents ${N_LEADS}   audit 120
--
-- CLEANUP (removes the WHOLE test org and every dependent row via cascade):
--   psql -U shadhil -d shadhil_crm -c "DELETE FROM \\"Organization\\" WHERE id = '${ORG_ID}';"
-- ============================================================================
`);

const outArgIdx = process.argv.indexOf('--out');
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// Writing the file is a CLI side effect ONLY - importing this module (which
// seed-test-user.ts does, to run the same statements through Prisma) must not
// touch the filesystem or the console.
if (invokedDirectly) {
  const outPath = resolve(
    outArgIdx !== -1
      ? process.argv[outArgIdx + 1]!
      : fileURLToPath(new URL('./seed-test-user.sql', import.meta.url)),
  );
  writeFileSync(outPath, parts.join('\n'), 'utf8');

  // eslint-disable-next-line no-console
  console.log(
    `[generate-test-data] wrote ${outPath}\n` +
      `  users ${N_TELE + N_SALES + N_MGR + N_ADMIN} (+owner) · teams ${N_NEW_TEAMS} · units ${N_UNITS} · leads ${N_LEADS} · bookings ${N_BOOKINGS} · ` +
      `activities ${N_LEADS * 2} · messages ${N_LEADS * 3} · visits ${N_LEADS} · notifications 120 · reminders 120 · consents ${N_LEADS} · audit 120\n` +
      `  login: ${TEST_USER_EMAIL} / ${TEST_PASSWORD}`,
  );
}

// Totals + identity, so a consumer (scripts/seed-test-user.ts) prints the same
// summary without restating any of the numbers.
export const TEST_DATA_SUMMARY = {
  orgId: ORG_ID,
  orgName: ORG_NAME,
  orgSlug: ORG_SLUG,
  email: TEST_USER_EMAIL,
  password: TEST_PASSWORD,
  counts: {
    users: N_TELE + N_SALES + N_MGR + N_ADMIN + 1,
    teams: N_NEW_TEAMS,
    units: N_UNITS,
    leads: N_LEADS,
    bookings: N_BOOKINGS,
    activities: N_LEADS * 2,
    messages: N_LEADS * 3,
    visits: N_LEADS,
    notifications: 120,
    reminders: 120,
    consents: N_LEADS,
    audit: 120,
  },
} as const;
