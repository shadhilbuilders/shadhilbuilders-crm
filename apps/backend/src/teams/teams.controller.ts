// Teams controller - JWT-protected list endpoint.
//
// Mirrors the leads/ controller pattern: no per-route guards (the
// global JwtAuthGuard does that), the service enforces role/data
// scoping, and any future writes (e.g. POST /api/teams to create a
// new team) would add DTO parsing here using a shared Zod schema
// from @shadhil/api-types.
import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import type { TeamDetail, TeamListItem } from '@shadhil/api-types';

import { TeamsService } from './teams.service';

@ApiTags('teams')
@ApiBearerAuth('jwt')
@Controller('teams')
export class TeamsController {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime (same as users.service.ts / leads.service.ts).
  constructor(
    @Inject(TeamsService) private readonly teams: TeamsService,
  ) {}

  /**
   * GET /api/teams
   *
   * List teams the current user is a member of. Used by the sidebar
   * <TeamSwitcher> dropdown.
   */
  @Get()
  @ApiOperation({
    summary: 'List teams the current user is a member of (RLS-filtered).',
  })
  async list(@Req() req: AuthedRequest): Promise<TeamListItem[]> {
    return this.teams.list(req.user!);
  }

  /**
   * GET /api/teams/:id
   *
   * The ADMIN/OWNER org-Teams roster: team info + manager + members each
   * with their project assignments. ADMIN/OWNER only (service gate).
   */
  @Get(':id')
  @ApiOperation({
    summary:
      'Get a team roster (manager + members w/ project assignments). ADMIN/OWNER only.',
  })
  async getOne(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<TeamDetail> {
    return this.teams.getTeam(req.user!, id);
  }
}
