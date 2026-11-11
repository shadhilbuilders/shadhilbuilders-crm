// Site-updates unit list (2026-11-10): "whose villas does this person see on the
// Site updates page?" answered server-side, per role.
//
//   ENGINEER      -> villas assigned to them                    (scope ASSIGNED)
//   MANAGER       -> villas assigned to engineers on teams they lead (MANAGED)
//   ADMIN / OWNER -> every villa of the project                 (ALL)
//   anyone else   -> 403 (TELECALLER / SALES_EXEC / CUSTOMER have no site page)
//
// Read-only for MANAGER/ADMIN/OWNER (`canCapture` is true for ENGINEER alone).
// Money is never selected: the site page has no use for it, and the engineer
// shape is the least-privilege one for every audience.
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { rlsContextFrom, withRlsContext, type Prisma, type PrismaClient } from '@shadhil/database';
import type { SiteUnitScope, SiteUnitsResult } from '@shadhil/api-types';

import { toUnitRow, unitRowSelectFor } from '../inventory/unit-row';
import { PrismaService } from '../prisma/prisma.module';

/** Hard cap on one site-units response (the page renders a map, not a table). */
export const SITE_UNITS_CAP = 200;

/** Scope for a role, or null when the role has no Site updates page. */
export function siteScopeFor(role: JwtPayload['role']): SiteUnitScope | null {
  if (role === 'ENGINEER') return 'ASSIGNED';
  if (role === 'MANAGER') return 'MANAGED';
  if (role === 'ADMIN' || role === 'OWNER') return 'ALL';
  return null;
}

/** The Unit filter that implements a scope for one actor. Pure, unit-tested. */
export function siteScopeWhere(
  scope: SiteUnitScope,
  actorId: string,
): Prisma.UnitWhereInput {
  switch (scope) {
    case 'ASSIGNED':
      return { assignedEngineerId: actorId };
    case 'MANAGED':
      return {
        assignedEngineer: {
          teamMemberships: { some: { team: { managerId: actorId, deletedAt: null } } },
        },
      };
    case 'ALL':
      return {};
  }
}

@Injectable()
export class SiteUnitsService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  async list(actor: JwtPayload, projectId: string): Promise<SiteUnitsResult> {
    const scope = siteScopeFor(actor.role);
    if (scope === null) {
      throw new ForbiddenException(
        `${actor.role} has no Site updates page. Ask an admin if you need site visibility.`,
      );
    }
    const where: Prisma.UnitWhereInput = {
      organizationId: actor.organizationId,
      phase: { projectId, project: { deletedAt: null } },
      ...siteScopeWhere(scope, actor.sub),
    };
    return withRlsContext(this.prismaService.$client, rlsContextFrom(actor), async (tx) => {
      const db = tx as unknown as PrismaClient;
      const [rows, total] = await Promise.all([
        db.unit.findMany({
          where,
          select: unitRowSelectFor(false),
          orderBy: [{ phaseId: 'asc' }, { unitNumber: 'asc' }],
          take: SITE_UNITS_CAP,
        }),
        db.unit.count({ where }),
      ]);
      return {
        scope,
        canCapture: actor.role === 'ENGINEER',
        total,
        rows: rows.map((r) => toUnitRow(r, false)),
      };
    });
  }
}
