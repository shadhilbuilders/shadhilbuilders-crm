// T-ORG-OWNER (2026-09-17): unit tests for the signup → org-creation →
// OWNER-promotion chain (Gap A hardening). These are the security-critical
// rules that make the org creator the owner with full access:
//   1. An org is created with `createdBy` = the new user + a unique slug.
//   2. The user is promoted to OWNER and their organizationId is pointed at
//      the new org.
//   3. A signup WITHOUT organizationName creates no org and changes nothing
//      (the seed/admin-created path stays untouched).
//   4. A slug clash appends -2, -3... until unique.
//
// Uses a mocked PrismaClient (no DB), mirroring auth.test.ts's isolation.
import { describe, expect, it, vi } from 'vitest';

import { createOrgForSignup, type OrgOwnerHookInput } from '../src/org-owner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose mock; PrismaClient is opaque here
type MockPrisma = any;

function makePrisma(overrides: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose mock
  const orgCreate = vi.fn().mockImplementation(async (args: any) => ({
    id: `org-${args.data.slug}`,
  }));
  const userUpdate = vi.fn().mockResolvedValue({ id: 'user-1' });
  const orgFindUnique = vi.fn().mockResolvedValue(null); // no slug clash by default
  // Spread `organization` after the base so an override like
  // `{ organization: { findUnique } }` doesn't drop `create`.
  const prisma = {
    ...overrides,
    organization: {
      create: orgCreate,
      findUnique: orgFindUnique,
      ...((overrides.organization as Record<string, unknown> | undefined) ?? {}),
    },
    user: {
      update: userUpdate,
      ...((overrides.user as Record<string, unknown> | undefined) ?? {}),
    },
  };
  return {
    prisma: prisma as unknown as MockPrisma,
    orgCreate,
    userUpdate,
    orgFindUnique,
  };
}

const slugify = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

function hookInput(
  prisma: MockPrisma,
  user: Record<string, unknown> = {},
): OrgOwnerHookInput {
  return {
    prisma,
    user: {
      id: 'user-1',
      email: 'creator@x.in',
      name: 'Creator',
      ...user,
    } as OrgOwnerHookInput['user'],
    slugify,
  };
}

describe('createOrgForSignup (T-ORG-OWNER, Gap A hardening)', () => {
  it('creates an org owned by the signup and promotes the user to OWNER (bound to the new org)', async () => {
    const { prisma, orgCreate, userUpdate } = makePrisma();
    const orgId = await createOrgForSignup(
      hookInput(prisma, { organizationName: 'Acme Constructions' }),
    );

    expect(orgId).toBeTruthy();
    // 1. Org created with the creator as createdBy + a slugified name.
    expect(orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Acme Constructions',
          slug: 'acme-constructions',
          createdBy: 'user-1',
        }),
      }),
    );
    // 2. The creator is promoted to OWNER and bound to the new org.
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: expect.objectContaining({
        role: 'OWNER',
        organizationId: orgId,
      }),
    });
  });

  it('does nothing (no org, no role change) when a signup omits organizationName', async () => {
    const { prisma, orgCreate, userUpdate } = makePrisma();
    const result = await createOrgForSignup(hookInput(prisma, {}));
    expect(result).toBeUndefined();
    expect(orgCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('does nothing for a blank (whitespace-only) organizationName', async () => {
    const { prisma, orgCreate, userUpdate } = makePrisma();
    const result = await createOrgForSignup(
      hookInput(prisma, { organizationName: '   ' }),
    );
    expect(result).toBeUndefined();
    expect(orgCreate).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it('appends a numeric suffix when the slug is already taken (unique within orgs)', async () => {
    const orgFindUnique = vi
      .fn()
      .mockResolvedValueOnce({ id: 'existing-org' }) // base slug taken
      .mockResolvedValue(null); // -2 free
    const { prisma, orgCreate } = makePrisma({
      organization: { findUnique: orgFindUnique },
    });
    const orgId = await createOrgForSignup(
      hookInput(prisma, { organizationName: 'Acme Constructions' }),
    );
    expect(orgId).toBe('org-acme-constructions-2');
    expect(orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ slug: 'acme-constructions-2' }),
      }),
    );
  });
});
