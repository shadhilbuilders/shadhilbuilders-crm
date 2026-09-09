// Dashboard controller - one aggregate endpoint for the project work dashboard.
//
// Mirrors the leads/visits controller patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//   - Global JwtAuthGuard handles authentication (no per-route guard)
//
// The service enforces role scoping (TELECALLER/SALES_EXEC own, MANAGER team,
// ADMIN/OWNER all) inside withRlsContext - the controller is a thin parse +
// delegate.
import { BadRequestException, Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DashboardStatsQuerySchema,
  type DashboardOverviewStats,
  type DashboardStats,
  type DashboardStatsQuery,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { DashboardService } from './dashboard.service';

function parseQuery<T>(schema: z.ZodType<T>, query: Record<string, unknown>): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

@ApiTags('dashboard')
@ApiBearerAuth('jwt')
@Controller('dashboard')
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboard: DashboardService,
  ) {}

  @Get('stats')
  @ApiOperation({
    summary:
      'Dashboard stats (KPIs + charts). Role-scoped: TELECALLER/SALES_EXEC see own; MANAGER sees team; ADMIN/OWNER sees all. projectId optional (omit for cross-project).',
  })
  async stats(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<DashboardStats> {
    const dto: DashboardStatsQuery = parseQuery(DashboardStatsQuerySchema, query);
    return this.dashboard.getStats(req.user!, dto);
  }

  @Get('overview')
  @ApiOperation({
    summary:
      'Cross-project overview (command center). ADMIN/OWNER only. Returns total leads, reassignments (7d), audit events (24h), users by role, pipeline, visits, audit timeline.',
  })
  async overview(@Req() req: AuthedRequest): Promise<DashboardOverviewStats> {
    return this.dashboard.getOverviewStats(req.user!);
  }
}
