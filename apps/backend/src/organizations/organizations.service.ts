// Organizations service - tenant lookup driven by the RLS context pattern.
//
// Mirrors teams.service: reads run inside withRlsContext so the global RLS
// policies (org-gated on app.user_org_id) filter results. A user who cannot
// access the org simply gets `null` (row invisible to them) -> 404 upstream.
import { Inject, Injectable } from '@nestjs/common';
import { withRlsContext, rlsContextFrom } from '@shadhil/database';
import type { PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { Organization } from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class OrganizationsService {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime. PrismaService is exported from prisma.module.ts.
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * List the orgs the caller can access (id + slug). Used to resolve an
   * id-keyed session back to a slug for href building.
   */
  async list(
    actor: JwtPayload,
  ): Promise<Array<{ id: string; name: string; slug: string }>> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const rows = await tx.organization.findMany({
        select: { id: true, name: true, slug: true },
        orderBy: { name: 'asc' },
      });
      return rows;
    });
  }

  /**
   * Resolve an org by slug. Returns null when the caller cannot access it
   * (RLS filters the row). Mirrors the leads/teams scoping convention.
   */
  async findBySlug(actor: JwtPayload, slug: string): Promise<Organization | null> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const row = await tx.organization.findUnique({
        where: { slug },
        select: { id: true, name: true, slug: true },
      });
      return row ?? null;
    });
  }
}
