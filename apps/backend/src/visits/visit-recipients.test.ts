import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@shadhil/database';

import { collectVisitStakeholders } from './visit-recipients';

function fakeDb(opts: {
  lead: { ownerId: string; teamId: string | null } | null;
  managerId: string | null;
  owners: string[];
  deactivated?: string[];
}): PrismaClient {
  const dead = new Set(opts.deactivated ?? []);
  return {
    lead: { findUnique: async () => opts.lead },
    team: { findFirst: async () => (opts.managerId ? { managerId: opts.managerId } : null) },
    user: {
      findMany: async (args: { where: { role?: string; id?: { in: string[] } } }) =>
        args.where.role === 'OWNER'
          ? opts.owners.map((id) => ({ id }))
          : (args.where.id?.in ?? []).filter((id) => !dead.has(id)).map((id) => ({ id })),
    },
  } as unknown as PrismaClient;
}

const input = { organizationId: 'org', leadId: 'l1', assigneeId: 'exec' };

describe('collectVisitStakeholders', () => {
  it('returns exec, lead owner, team manager and org owner', async () => {
    const ids = await collectVisitStakeholders(
      fakeDb({ lead: { ownerId: 'tc', teamId: 't' }, managerId: 'mgr', owners: ['own'] }),
      input,
    );
    expect(ids.sort()).toEqual(['exec', 'mgr', 'own', 'tc']);
  });

  it('de-duplicates when one person holds several roles', async () => {
    const ids = await collectVisitStakeholders(
      fakeDb({ lead: { ownerId: 'exec', teamId: 't' }, managerId: 'own', owners: ['own'] }),
      input,
    );
    expect(ids.sort()).toEqual(['exec', 'own']);
  });

  it('skips a lead with no team and drops deactivated accounts', async () => {
    const ids = await collectVisitStakeholders(
      fakeDb({
        lead: { ownerId: 'tc', teamId: null },
        managerId: 'mgr',
        owners: ['own'],
        deactivated: ['tc'],
      }),
      input,
    );
    expect(ids.sort()).toEqual(['exec', 'own']);
  });
});
