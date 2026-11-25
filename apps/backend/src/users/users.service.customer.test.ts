// UsersService.create / changeRole for the CUSTOMER role (issue #8 slice 2).
//
// protects= CUSTOMER provisioning rules: admin-class only, lead required and
//           same-org, no team, pointer rejected on every other role, no
//           role-change into CUSTOMER, pointer cleared when leaving it.
// fails_when= a MANAGER can mint/modify a CUSTOMER, a customer is created
//           without (or with a foreign-org) lead, a stale pointer survives a
//           demotion, or a non-customer accepts a pointer.
// no_claim= fake tx: nothing here proves the DB constraint or the RLS arms.
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '@shadhil/auth';

vi.mock('./credentials', () => ({
  hashPassword: vi.fn(() => 'salt:hash'),
  verifyPassword: vi.fn(),
  upsertCredentialAccount: vi.fn(async () => undefined),
}));
vi.mock('@shadhil/database', () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  rlsContextFrom: vi.fn((a: { sub: string; role: string; organizationId: string }) => ({
    userId: a.sub,
    role: a.role,
    organizationId: a.organizationId,
  })),
  withRlsContext: vi.fn(async (_c: unknown, _ctx: unknown, cb: (t: unknown) => unknown) =>
    cb((globalThis as { __tx?: unknown }).__tx),
  ),
}));

import { assertCanChangeRole, assertCanCreateRole } from './roles';
import { UsersService } from './users.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const NOW = Math.floor(Date.now() / 1000);
const actor = (role: JwtPayload['role'], sub = 'a-1'): JwtPayload => ({
  sub,
  email: `${sub}@x.in`,
  role,
  organizationId: ORG,
  iat: NOW,
  exp: NOW + 3600,
  iss: 'shadhil-bff',
});

function tx(over: Record<string, unknown> = {}) {
  // `user.findFirst` DELEGATES to `findUnique`, so a test that presets the row
  // once covers both the org-scoped target read (findFirst, 2026-11-25) and
  // every findUnique path. Presetting each separately is how these mocks drifted
  // from the service in the first place.
  const userMock = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'new-1',
      email: data.email,
      name: data.name,
      role: data.role,
    })),
    findUnique: vi.fn(),
    update: vi.fn(async ({ data }: { data: { role: string } }) => ({
      id: 't-1',
      email: 'c@x.in',
      name: 'C',
      role: data.role,
    })),
  };
  const findFirst = vi.fn((args: unknown) =>
    (userMock.findUnique as unknown as (a: unknown) => unknown)(args),
  );
  return {
    lead: { findFirst: vi.fn(async () => ({ id: 'lead-1' })) },
    team: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    teamMember: { create: vi.fn(), findFirst: vi.fn(async () => null) },
    user: { ...userMock, findFirst },
    account: { upsert: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn() },
    ...over,
  };
}
const setTx = (t: unknown) => {
  (globalThis as { __tx?: unknown }).__tx = t;
};
const svc = () => new UsersService({ $client: {} } as never);
const dto = (o: Record<string, unknown> = {}) =>
  ({
    name: 'Asha',
    email: 'asha@x.in',
    password: 'Passw0rd!x',
    role: 'CUSTOMER',
    customerLeadId: 'lead-1',
    ...o,
  }) as never;

describe('role gates', () => {
  it('only the admin class may create or change into/out of CUSTOMER', () => {
    expect(() => assertCanCreateRole('ADMIN', 'CUSTOMER')).not.toThrow();
    expect(() => assertCanCreateRole('OWNER', 'CUSTOMER')).not.toThrow();
    expect(() => assertCanCreateRole('MANAGER', 'CUSTOMER')).toThrow(ForbiddenException);
    expect(() => assertCanChangeRole('MANAGER', 'CUSTOMER', 'TELECALLER')).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanChangeRole('MANAGER', 'TELECALLER', 'CUSTOMER')).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanChangeRole('ADMIN', 'CUSTOMER', 'TELECALLER')).not.toThrow();
  });
});

describe('create CUSTOMER', () => {
  beforeEach(() => setTx(tx()));

  it('creates the user with the lead pointer, no team, and audits it', async () => {
    const t = tx();
    setTx(t);
    const res = await svc().create(actor('ADMIN'), dto());
    expect(t.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        role: 'CUSTOMER',
        customerLeadId: 'lead-1',
        organizationId: ORG,
      }),
    });
    expect(t.teamMember.create).not.toHaveBeenCalled();
    expect(t.auditLog.create).toHaveBeenCalled();
    expect(res.teamId).toBeNull();
  });

  // issue #8 slice 2, D3: a provisioned buyer's password was read out over
  // WhatsApp and typed by someone else, so it MUST be rotated on first login.
  // protects= CUSTOMER creation arms the mustChangePassword gate;
  // fails_when= the create omits the flag and the buyer keeps the temp password;
  // no_claim= does not exercise the guard that enforces it (jwt-auth.guard
  // owns that) nor the change-password write that clears it.
  it('protects= arms mustChangePassword so the temp password must be rotated', async () => {
    const t = tx();
    setTx(t);
    await svc().create(actor('ADMIN'), dto());
    expect(t.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ mustChangePassword: true }),
    });
  });

  it('fails_when= a staff role is created gated (only CUSTOMER arms it)', async () => {
    const t = tx({
      team: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(async () => ({ id: 'team-1', deletedAt: null })),
        create: vi.fn(),
      },
    });
    setTx(t);
    await svc().create(
      actor('ADMIN'),
      dto({ role: 'TELECALLER', customerLeadId: undefined, teamId: 'team-1' }),
    );
    const data = t.user.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.mustChangePassword).toBeUndefined();
  });

  it('requires customerLeadId', async () => {
    await expect(
      svc().create(actor('ADMIN'), dto({ customerLeadId: undefined })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a teamId for a customer', async () => {
    await expect(svc().create(actor('ADMIN'), dto({ teamId: 'team-1' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('404s a lead that is not in the actor org (reads as absent)', async () => {
    const t = tx({ lead: { findFirst: vi.fn(async () => null) } });
    setTx(t);
    await expect(svc().create(actor('ADMIN'), dto())).rejects.toBeInstanceOf(NotFoundException);
    expect(t.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'lead-1', organizationId: ORG } }),
    );
    expect(t.user.create).not.toHaveBeenCalled();
  });

  it('rejects customerLeadId on a non-CUSTOMER role', async () => {
    await expect(
      svc().create(actor('ADMIN'), dto({ role: 'TELECALLER', teamId: 'team-1' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a MANAGER cannot create a CUSTOMER', async () => {
    await expect(svc().create(actor('MANAGER'), dto())).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('changeRole around CUSTOMER', () => {
  it('clears customerLeadId in the same write when a CUSTOMER becomes staff', async () => {
    const t = tx();
    t.user.findUnique.mockResolvedValue({ id: 't-1', role: 'CUSTOMER', name: 'C' });
    setTx(t);
    await svc().changeRole(actor('ADMIN'), 't-1', { role: 'TELECALLER' } as never);
    expect(t.user.update).toHaveBeenCalledWith({
      where: { id: 't-1' },
      data: { role: 'TELECALLER', customerLeadId: null },
    });
  });

  it('refuses to turn a staff user into a CUSTOMER (no lead pointer to collect)', async () => {
    const t = tx();
    t.user.findUnique.mockResolvedValue({ id: 't-1', role: 'TELECALLER', name: 'T' });
    setTx(t);
    await expect(
      svc().changeRole(actor('ADMIN'), 't-1', { role: 'CUSTOMER' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.user.update).not.toHaveBeenCalled();
  });
});
