// Customer portal controller (issue #8 slice 2).
//
// GET /api/customer-portal/me                      - the buyer's units
// GET /api/customer-portal/units/:unitId/photos    - timeline (cursor, optional ?stage=)
// GET /api/customer-portal/units/:unitId/stages    - per-stage totals for the chips
//
// Auth: global JwtAuthGuard (NOT @Public). Role + ownership checks live in
// CustomerPortalService; RLS is the second wall.
import { BadRequestException, Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ConstructionStageSchema, type ConstructionStage } from '@shadhil/api-types';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import type {
  StageCountsResponseDto,
  TimelineResponseDto,
} from '../customer-progress/progress-photo.mapper';
import { CustomerPortalService, type PortalMeDto } from './customer-portal.service';

@ApiTags('customer-portal')
@ApiBearerAuth('jwt')
@Controller('customer-portal')
export class CustomerPortalController {
  constructor(@Inject(CustomerPortalService) private readonly service: CustomerPortalService) {}

  @Get('me')
  @ApiOperation({ summary: "The signed-in buyer's APPROVED units (CUSTOMER only)." })
  async me(@Req() req: AuthedRequest): Promise<PortalMeDto> {
    return this.service.me(req.user!);
  }

  @Get('units/:unitId/photos')
  @ApiOperation({
    summary:
      "Progress timeline for one of the buyer's units (newest first, 50/page, optional ?stage=).",
  })
  async timeline(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
    @Query('cursor') cursor?: string,
    @Query('stage') stage?: string,
  ): Promise<TimelineResponseDto> {
    return this.service.timeline(req.user!, unitId, cursor, parseStageFilter(stage));
  }

  @Get('units/:unitId/stages')
  @ApiOperation({ summary: "Per-stage totals for one of the buyer's units." })
  async stages(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
  ): Promise<StageCountsResponseDto> {
    return this.service.stageCounts(req.user!, unitId);
  }
}

/**
 * `?stage=` on the buyer timeline.
 *
 * Absent or empty means every item, which is what every pre-existing client
 * sends. `UNSET` selects the captures that recorded no stage - a real bucket the
 * chips offer, and the only way to express "null" in a query string. Anything
 * else must be a real stage: a typo answered with a silently unfiltered page
 * would look like the filter works and is the kind of bug nobody reports.
 */
export function parseStageFilter(raw: string | undefined): ConstructionStage | 'UNSET' | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = raw.trim();
  if (value === 'UNSET') return 'UNSET';
  const parsed = ConstructionStageSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(`Unknown stage "${value}". Use a construction stage or UNSET.`);
  }
  return parsed.data;
}
