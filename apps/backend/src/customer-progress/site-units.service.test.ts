// Site-units scope (2026-11-10).
// protects= each role sees exactly its own slice of villas, read-only for all
// but the engineer; fails_when= a role gets a wider scope (e.g. a MANAGER seeing
// every villa) or TELECALLER/SALES_EXEC gets a site page at all.
// no_claim= green does not run SQL: the manager-team join is proven end to end
// by the e2e role-gate spec and the RLS matrix.
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';

import { SiteUnitsService, siteScopeFor, siteScopeWhere } from './site-units.service';

const actorAs = (role: JwtPayload['role'], sub = 'u-1'): JwtPayload => ({
  sub,
  email: 'x@y.z',
  role,
  organizationId: 'org-1',
  iat: 0,
  exp: 0,
  iss: 'shadhil-crm',
});

describe('siteScopeFor', () => {
  it('maps the four viewing roles', () => {
    expect(siteScopeFor('ENGINEER')).toBe('ASSIGNED');
    expect(siteScopeFor('MANAGER')).toBe('MANAGED');
    expect(siteScopeFor('ADMIN')).toBe('ALL');
    expect(siteScopeFor('OWNER')).toBe('ALL');
  });

  it('gives TELECALLER, SALES_EXEC and CUSTOMER no site page', () => {
    for (const role of ['TELECALLER', 'SALES_EXEC', 'CUSTOMER'] as const) {
      expect(siteScopeFor(role)).toBeNull();
    }
  });
});

describe('siteScopeWhere', () => {
  it('ASSIGNED narrows to the actor', () => {
    expect(siteScopeWhere('ASSIGNED', 'eng-1')).toEqual({ assignedEngineerId: 'eng-1' });
  });

  it('MANAGED narrows to engineers on teams the actor leads (live teams only)', () => {
    expect(siteScopeWhere('MANAGED', 'mgr-1')).toEqual({
      assignedEngineer: {
        teamMemberships: { some: { team: { managerId: 'mgr-1', deletedAt: null } } },
      },
    });
  });

  it('ALL adds no narrowing', () => {
    expect(siteScopeWhere('ALL', 'admin-1')).toEqual({});
  });
});

function makeService() {
  const unit = {
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    unit,
  };
  return { service: new SiteUnitsService({ $client: client } as never), unit };
}

describe('SiteUnitsService.list', () => {
  it('rejects roles without a site page with a 403', async () => {
    const { service } = makeService();
    await expect(service.list(actorAs('TELECALLER'), 'proj-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('ENGINEER query is scoped to their id and may capture', async () => {
    const { service, unit } = makeService();
    const res = await service.list(actorAs('ENGINEER', 'eng-1'), 'proj-1');
    expect(res).toMatchObject({ scope: 'ASSIGNED', canCapture: true, total: 0, rows: [] });
    expect(unit.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      organizationId: 'org-1',
      assignedEngineerId: 'eng-1',
      phase: { projectId: 'proj-1' },
    });
  });

  it('ADMIN sees all villas read-only, and never selects money', async () => {
    const { service, unit } = makeService();
    const res = await service.list(actorAs('ADMIN'), 'proj-1');
    expect(res).toMatchObject({ scope: 'ALL', canCapture: false });
    const call = unit.findMany.mock.calls[0]?.[0];
    expect(call.where).not.toHaveProperty('assignedEngineerId');
    expect(call.select).not.toHaveProperty('price');
    expect(call.take).toBe(200);
  });

  it('MANAGER is read-only and team-scoped', async () => {
    const { service, unit } = makeService();
    const res = await service.list(actorAs('MANAGER', 'mgr-1'), 'proj-1');
    expect(res).toMatchObject({ scope: 'MANAGED', canCapture: false });
    expect(unit.findMany.mock.calls[0]?.[0]?.where).toHaveProperty('assignedEngineer');
  });
});
