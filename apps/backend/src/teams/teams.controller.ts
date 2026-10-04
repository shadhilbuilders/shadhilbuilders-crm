// Teams controller - JWT-protected list endpoint.
//
// Mirrors the leads/ controller pattern: no per-route guards (the
// global JwtAuthGuard does that), the service enforces role/data
// scoping, and any future writes (e.g. POST /api/teams to create a
// new team) would add DTO parsing here using a shared Zod schema
// from @shadhil/api-types.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AddTeamMembersDtoSchema,
  CreateTeamDtoSchema,
  ReassignTeamMembersDtoSchema,
  UpdateTeamDtoSchema,
  type AddTeamMembersDto,
  type AddTeamMembersResult,
  type CreateTeamDto,
  type ReassignTeamMembersDto,
  type UpdateTeamDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import type { TeamDetail, TeamListItem } from '@shadhil/api-types';

import { TeamsService } from './teams.service';

// Mirrors projects.controller.ts's parseBody helper - ZodError -> 400 with
// readable field-level messages.
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'body'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

// Team id format: real cuid2 - mirrors projects.controller.ts's ID_RE.
const ID_RE = z.cuid2();

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

  /**
   * POST /api/teams
   *
   * Create a team. ADMIN/OWNER only (service guard).
   */
  @Post()
  @ApiOperation({
    summary: 'Create a team. ADMIN/OWNER only.',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<TeamListItem> {
    const dto: CreateTeamDto = parseBody(CreateTeamDtoSchema, body);
    return this.teams.create(req.user!, dto);
  }

  /**
   * PATCH /api/teams/:id
   *
   * Rename and/or reassign the manager. ADMIN/OWNER only.
   */
  @Patch(':id')
  @ApiOperation({
    summary: 'Update a team (name / manager). ADMIN/OWNER only.',
  })
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TeamListItem> {
    if (!ID_RE.safeParse(id).success) {
      throw new BadRequestException(`Invalid team id: ${id}`);
    }
    const dto: UpdateTeamDto = parseBody(UpdateTeamDtoSchema, body);
    return this.teams.update(req.user!, id, dto);
  }

  /**
   * DELETE /api/teams/:id
   *
   * Soft delete. ADMIN/OWNER only. 409 when the team still has members or
   * an active manager.
   */
  @Delete(':id')
  @ApiOperation({
    summary:
      'Delete a team. ADMIN/OWNER only. 409 when members or a manager still exist.',
  })
  async remove(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    if (!ID_RE.safeParse(id).success) {
      throw new BadRequestException(`Invalid team id: ${id}`);
    }
    return this.teams.remove(req.user!, id);
  }

  /**
   * POST /api/teams/:id/members
   *
   * Add existing telecallers / sales execs to this team (additive).
   * ADMIN/OWNER only.
   */
  @Post(':id/members')
  @ApiOperation({
    summary:
      'Add telecallers / sales execs to a team (additive, skips existing members). ADMIN/OWNER only.',
  })
  async addMembers(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AddTeamMembersResult> {
    if (!ID_RE.safeParse(id).success) {
      throw new BadRequestException(`Invalid team id: ${id}`);
    }
    const dto: AddTeamMembersDto = parseBody(AddTeamMembersDtoSchema, body);
    return this.teams.addMembers(req.user!, id, dto);
  }

  /**
   * POST /api/teams/:id/reassign-members
   *
   * Move members off this team. ADMIN/OWNER only. Omitting `userIds`
   * reassigns everyone (the one-click bulk action); passing ids reassigns
   * only those members.
   */
  @Post(':id/reassign-members')
  @ApiOperation({
    summary:
      'Reassign this team\'s members to another team. ADMIN/OWNER only. ' +
      'Omit userIds to move everyone (bulk); pass ids to move only those members.',
  })
  async reassignMembers(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ count: number }> {
    if (!ID_RE.safeParse(id).success) {
      throw new BadRequestException(`Invalid team id: ${id}`);
    }
    const dto: ReassignTeamMembersDto = parseBody(
      ReassignTeamMembersDtoSchema,
      body,
    );
    return this.teams.reassignMembers(req.user!, id, dto);
  }
}
