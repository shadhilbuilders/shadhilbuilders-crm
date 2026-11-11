// Customer portal controller (issue #8 slice 2).
//
// GET /api/customer-portal/me                      - the buyer's units
// GET /api/customer-portal/units/:unitId/photos    - timeline (cursor)
//
// Auth: global JwtAuthGuard (NOT @Public). Role + ownership checks live in
// CustomerPortalService; RLS is the second wall.
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import type { TimelineResponseDto } from '../customer-progress/progress-photo.mapper';
import { CustomerPortalService, type PortalMeDto } from './customer-portal.service';

@ApiTags('customer-portal')
@ApiBearerAuth('jwt')
@Controller('customer-portal')
export class CustomerPortalController {
  constructor(
    @Inject(CustomerPortalService) private readonly service: CustomerPortalService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: "The signed-in buyer's APPROVED units (CUSTOMER only)." })
  async me(@Req() req: AuthedRequest): Promise<PortalMeDto> {
    return this.service.me(req.user!);
  }

  @Get('units/:unitId/photos')
  @ApiOperation({ summary: "Progress timeline for one of the buyer's units (newest first, 50/page)." })
  async timeline(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
    @Query('cursor') cursor?: string,
  ): Promise<TimelineResponseDto> {
    return this.service.timeline(req.user!, unitId, cursor);
  }
}
