// Milestones controller (portal redesign, 2026-11-09).
//
// GET /api/milestones/:projectId  - the project's checkpoints (staff + engineers)
// PUT /api/milestones/:projectId  - replace the whole list (ADMIN/OWNER)
//
// Auth: global JwtAuthGuard (NOT @Public). Buyers read milestones through
// /customer-portal/me; a buyer token that reaches GET here is still confined by
// RLS (customer_can_read_project) to its own project, and PUT is ADMIN-only.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ReplaceMilestonesDtoSchema,
  type ProjectMilestoneRow,
  type ReplaceMilestonesDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { MilestonesService } from './milestones.service';

const CUID_RE = z.cuid2();

function projectIdOf(raw: string): string {
  if (!CUID_RE.safeParse(raw).success) throw new BadRequestException(`Invalid project id: ${raw}`);
  return raw;
}

@ApiTags('milestones')
@ApiBearerAuth('jwt')
@Controller('milestones')
export class MilestonesController {
  constructor(@Inject(MilestonesService) private readonly milestones: MilestonesService) {}

  @Get(':projectId')
  @ApiOperation({ summary: "A project's buyer-visible milestones, in staff order." })
  async list(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
  ): Promise<ProjectMilestoneRow[]> {
    return this.milestones.list(req.user!, projectIdOf(projectId));
  }

  @Put(':projectId')
  @ApiOperation({
    summary: "Replace a project's milestone list. ADMIN/OWNER only. Audit row with before/after.",
  })
  async replace(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
    @Body() body: unknown,
  ): Promise<ProjectMilestoneRow[]> {
    const parsed = ReplaceMilestonesDtoSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      );
    }
    const dto: ReplaceMilestonesDto = parsed.data;
    return this.milestones.replace(req.user!, projectIdOf(projectId), dto);
  }
}
