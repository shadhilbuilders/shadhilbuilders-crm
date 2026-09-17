// TeamMembersController - T-TEAM-AUTHORITATIVE (2026-09-13).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ReassignAndRemoveDtoSchema,
  UpdateTeamMemberWeightDtoSchema,
  type ReassignAndRemoveDto,
  type ReassignAndRemoveResponse,
  type RemovalPreviewResponse,
  type UpdateTeamMemberWeightDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';

import { TeamMembersService } from './team-members.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    );
  }
  return result.data;
}

const ID_RE = z.cuid2();

@ApiTags('team-members')
@ApiBearerAuth('jwt')
@Controller('teams/:teamId/members/:userId')
export class TeamMembersController {
  constructor(
    @Inject(TeamMembersService) private readonly teamMembers: TeamMembersService,
  ) {}

  @Get('removal-preview')
  @ApiOperation({
    summary:
      'Preview removing a member from a team: affected owned/co-owned ' +
      'leads, eligible same-team replacements, and an opaque previewToken. ' +
      'ADMIN/OWNER on any team; MANAGER only on teams they manage.',
  })
  async preview(
    @Req() req: AuthedRequest,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
  ): Promise<RemovalPreviewResponse> {
    this.validateIds(teamId, userId);
    return this.teamMembers.preview(req.user!, teamId, userId);
  }

  @Post('reassign-and-remove')
  @ApiOperation({
    summary:
      'Transfer every lead the member owns/co-owns on this team to an ' +
      'eligible replacement, then remove the membership. Atomic; ' +
      'idempotent on `requestId`.',
  })
  async reassignAndRemove(
    @Req() req: AuthedRequest,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<ReassignAndRemoveResponse> {
    this.validateIds(teamId, userId);
    const dto: ReassignAndRemoveDto = parseBody(ReassignAndRemoveDtoSchema, body);
    return this.teamMembers.reassignAndRemove(req.user!, teamId, userId, dto);
  }

  // T-AUTOASSIGN (2026-09-17): update a member's routing weight. PATCH (not
  // POST) because it's a direct field update, not an action flow.
  @Patch('weight')
  @ApiOperation({
    summary:
      'Update a member\'s auto-assign routing weight. ADMIN/OWNER or the team\'s manager only.',
  })
  async updateWeight(
    @Req() req: AuthedRequest,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<{ userId: string; teamId: string; weight: number }> {
    this.validateIds(teamId, userId);
    const dto: UpdateTeamMemberWeightDto = parseBody(UpdateTeamMemberWeightDtoSchema, body);
    return this.teamMembers.updateWeight(req.user!, teamId, userId, dto);
  }

  private validateIds(teamId: string, userId: string): void {
    if (!ID_RE.safeParse(teamId).success || !ID_RE.safeParse(userId).success) {
      throw new BadRequestException(`Invalid id: ${teamId}/${userId}`);
    }
  }
}
