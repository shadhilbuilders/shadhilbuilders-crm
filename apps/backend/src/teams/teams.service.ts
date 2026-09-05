// Teams service - data access for the teams endpoint.
//
// The list() method respects the global RLS context: withRlsContext
// sets the app.user_id session var, and the Team table's RLS policy
// (see packages/database/prisma/rls/policies.sql) filters rows to
// teams the user is a member of. All reads run inside withRlsContext
// (per shadhil-crm-dev rule: every business query runs inside
// withRlsContext; the bare client is for migrations/seed/auth).
import { Inject, Injectable } from '@nestjs/common';
import { withRlsContext } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { PrismaClient } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';

export type TeamListItem = {
  id: string;
  name: string;
  defaultAssigneeId: string | null;
  memberCount: number;
};

@Injectable()
export class TeamsService {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime. PrismaService is exported from prisma.module.ts.
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /** List the teams the actor is a member of. RLS-filtered. */
  async list(actor: JwtPayload): Promise<TeamListItem[]> {
    return withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        // OWNER/ADMIN oversee every project (mirrors the leads scoping
        // convention - role lane, not membership). MANAGER/TELECALLER/
        // SALES_EXEC see only teams they are members of.
        const isOverseer =
          actor.role === 'OWNER' || actor.role === 'ADMIN';
        const rows = await tx.team.findMany({
          where: isOverseer
            ? {}
            : {
                // Belt-and-braces: even though the RLS policy on Team
                // already filters to rows where the user appears in
                // members, we add an explicit where so the SQL is
                // self-documenting and the index is obvious. With FORCE
                // RLS the policy is the only thing that matters, so this
                // is redundant - but if RLS is ever dropped in a future
                // migration, this still gives the right answer.
                members: { some: { id: actor.sub } },
              },
          select: {
            id: true,
            name: true,
            defaultAssigneeId: true,
            _count: { select: { members: true } },
          },
          orderBy: { name: 'asc' },
        });
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          defaultAssigneeId: r.defaultAssigneeId,
          memberCount: r._count.members,
        }));
      },
    );
  }
}