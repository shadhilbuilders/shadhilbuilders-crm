// Customer-progress controller (issue #7 slice 1; correction routes slice 4).
//
// POST   /api/customer-progress/units/:unitId/photos   - upload a site photo
// GET    /api/customer-progress/units/:unitId/photos   - staff timeline (cursor)
// POST   /api/customer-progress/projects/:projectId/members/:userId/photo-lead
//                                                      - grant/revoke (OWNER/ADMIN)
// PATCH  /api/customer-progress/photos/:photoId        - correct a caption
// DELETE /api/customer-progress/photos/:photoId        - delete row + bytes
//
// Auth: global JwtAuthGuard (not @Public). Authorization per the spec matrix
// inside the service (withRlsContext second wall).
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
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SiteUnitsService } from './site-units.service';
import type { AuthedRequest } from '../auth/jwt-auth.guard';
import {
  CustomerProgressService,
  SetPhotoLeadSchema,
  UpdatePhotoSchema,
  UploadPhotoSchema,
  type TimelinePhotoDto,
  type TimelineResponseDto,
} from './customer-progress.service';

@ApiTags('customer-progress')
@ApiBearerAuth('jwt')
@Controller('customer-progress')
export class CustomerProgressController {
  constructor(
    @Inject(CustomerProgressService) private readonly service: CustomerProgressService,
    @Inject(SiteUnitsService) private readonly siteUnits: SiteUnitsService,
  ) {}

  @Get('site-units')
  @ApiOperation({
    summary:
      'Villas on the Site updates page, scoped by role: ENGINEER assigned, MANAGER team-managed, ADMIN/OWNER all.',
  })
  async siteUnitsList(
    @Req() req: AuthedRequest,
    @Query('projectId') projectId?: string,
  ): Promise<unknown> {
    if (typeof projectId !== 'string' || projectId.length === 0) {
      throw new BadRequestException('projectId is required');
    }
    return this.siteUnits.list(req.user!, projectId);
  }

  @Post('units/:unitId/photos')
  @ApiOperation({ summary: 'Upload a site progress photo (staff; project membership required).' })
  async upload(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = UploadPhotoSchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
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
  @ApiOperation({
    summary: 'Grant/revoke the per-project photo-lead authority (OWNER/ADMIN only).',
  })
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

  // ── Photo correction (slice 4) ────────────────────────────────────────────
  // Authority is RLS's: ADMIN, the CREATOR, or the project's PHOTO_LEAD. The
  // service reads the row inside the caller's context, so a denied actor gets
  // 404 exactly like a missing photo - never a 403 that confirms it exists.

  @Patch('photos/:photoId')
  @ApiOperation({
    summary: 'Correct a photo caption (ADMIN, the uploader, or the project photo lead).',
  })
  async updatePhoto(
    @Req() req: AuthedRequest,
    @Param('photoId') photoId: string,
    @Body() body: unknown,
  ): Promise<TimelinePhotoDto> {
    const parsed = UpdatePhotoSchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new BadRequestException(msg || 'Invalid photo update');
    }
    return this.service.updatePhoto(req.user!, photoId, parsed.data);
  }

  @Delete('photos/:photoId')
  @ApiOperation({
    summary:
      'Delete a photo and its stored bytes (ADMIN, the uploader, or the project photo lead).',
  })
  async deletePhoto(
    @Req() req: AuthedRequest,
    @Param('photoId') photoId: string,
  ): Promise<{ id: string; unitId: string }> {
    return this.service.deletePhoto(req.user!, photoId);
  }
}
