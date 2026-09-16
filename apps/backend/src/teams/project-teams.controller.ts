// ProjectTeamsController - T-TEAM-AUTHORITATIVE (2026-09-13).
// Mirrors the projects.controller.ts / teams.controller.ts conventions:
// @Inject with an explicit token, parseBody(schema, body) -> 400, role
// guards live in the service (403/404/409 semantics).
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  LinkProjectTeamDtoSchema,
  type LinkProjectTeamDto,
  type ProjectTeamRow,
  type ProjectTeamsResponse,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';

import { ProjectTeamsService } from './project-teams.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    );
  }
  return result.data;
}

// cuid2 id format (matches ProjectsController's ID_RE convention).
const ID_RE = z.cuid2();

@ApiTags('project-teams')
@ApiBearerAuth('jwt')
@Controller('projects/:projectId/teams')
export class ProjectTeamsController {
  constructor(
    @Inject(ProjectTeamsService) private readonly projectTeams: ProjectTeamsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List teams linked to a project (ProjectTeam), each with manager, ' +
      'member count, lead count, roster, and canUnlink. All authenticated roles.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
  ): Promise<ProjectTeamsResponse> {
    if (!ID_RE.safeParse(projectId).success) {
      throw new BadRequestException(`Invalid project id: ${projectId}`);
    }
    return this.projectTeams.list(req.user!, projectId);
  }

  @Post()
  @ApiOperation({
    summary:
      'Link a team to a project. ADMIN/OWNER only. The team must be active ' +
      'and have a manager assigned. Idempotent.',
  })
  async link(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectTeamRow> {
    if (!ID_RE.safeParse(projectId).success) {
      throw new BadRequestException(`Invalid project id: ${projectId}`);
    }
    const dto: LinkProjectTeamDto = parseBody(LinkProjectTeamDtoSchema, body);
    return this.projectTeams.link(req.user!, projectId, dto);
  }

  @Delete(':teamId')
  @ApiOperation({
    summary:
      'Unlink a team from a project. ADMIN/OWNER only. 409 PROJECT_TEAM_HAS_LEADS ' +
      'when any lead still carries this (project, team) pair.',
  })
  async unlink(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
    @Param('teamId') teamId: string,
  ): Promise<{ ok: true }> {
    if (!ID_RE.safeParse(projectId).success || !ID_RE.safeParse(teamId).success) {
      throw new BadRequestException(`Invalid id: ${projectId}/${teamId}`);
    }
    return this.projectTeams.unlink(req.user!, projectId, teamId);
  }
}
