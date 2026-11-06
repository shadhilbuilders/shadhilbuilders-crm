// Customer-progress controller (issue #7 slice 1).
//
// POST /api/customer-progress/units/:unitId/photos   - upload a site photo
// GET  /api/customer-progress/units/:unitId/photos   - staff timeline (cursor)
// POST /api/customer-progress/projects/:projectId/members/:userId/photo-lead
//                                                    - grant/revoke (OWNER/ADMIN)
//
// Auth: global JwtAuthGuard (not @Public). Authorization per the spec matrix
// inside the service (withRlsContext second wall).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import {
  CustomerProgressService,
  SetPhotoLeadSchema,
  UploadPhotoSchema,
  type TimelineResponseDto,
} from './customer-progress.service';

@ApiTags('customer-progress')
@ApiBearerAuth('jwt')
@Controller('customer-progress')
export class CustomerProgressController {
  constructor(
    @Inject(CustomerProgressService) private readonly service: CustomerProgressService,
  ) {}

  @Post('units/:unitId/photos')
  @ApiOperation({ summary: 'Upload a site progress photo (staff; project membership required).' })
  async upload(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = UploadPhotoSchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(msg || 'Invalid upload payload');
    }
    return this.service.upload(req.user!, unitId, parsed.data);
  }

  @Get('units/:unitId/photos')
  @ApiOperation({ summary: 'Staff preview timeline for a unit (newest first, 50/page).' })
  async timeline(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
    @Query('cursor') cursor?: string,
  ): Promise<TimelineResponseDto> {
    return this.service.timeline(req.user!, unitId, cursor);
  }

  @Post('projects/:projectId/members/:userId/photo-lead')
  @ApiOperation({ summary: 'Grant/revoke the per-project photo-lead authority (OWNER/ADMIN only).' })
  async setPhotoLead(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<{ userId: string; projectId: string; photoLead: boolean }> {
    const parsed = SetPhotoLeadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('photoLead must be a boolean');
    }
    return this.service.setPhotoLead(req.user!, projectId, userId, parsed.data);
  }
}