// Site update video routes (plan section 8). Auth: the global JwtAuthGuard (not
// @Public); the service applies the same unit-access wall as the photo route and
// RLS is the second wall.
//
// POST   /customer-progress/units/:unitId/videos/upload-auth       - signed grant
// POST   /customer-progress/units/:unitId/videos/uploads/:uploadId - inline bytes (local disk)
// POST   /customer-progress/units/:unitId/videos                   - record after upload
// DELETE /customer-progress/units/:unitId/videos/pending/:uploadId - cancel an unrecorded upload
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { ZodType } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { InlineUploadSchema, RecordVideoSchema } from './site-video.schemas';
import { SiteVideoService, type UploadGrant } from './site-video.service';

function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  throw new BadRequestException(msg || 'Invalid request body');
}

@ApiTags('customer-progress')
@ApiBearerAuth('jwt')
@Controller('customer-progress/units/:unitId/videos')
export class SiteVideoController {
  private readonly logger = new Logger(SiteVideoController.name);

  constructor(@Inject(SiteVideoService) private readonly service: SiteVideoService) {}

  @Post('upload-auth')
  @HttpCode(200)
  @ApiOperation({ summary: 'Issue a short-lived, rate-limited grant to upload one clip (staff).' })
  async uploadAuth(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
  ): Promise<UploadGrant> {
    return this.service.uploadAuth(req.user!, unitId);
  }

  @Post('uploads/:uploadId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Upload one object into an issued folder (local-disk transport).' })
  async inlineUpload(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
    @Param('uploadId') uploadId: string,
    @Body() body: unknown,
  ): Promise<{ key: string; size: number }> {
    return this.service.inlineUpload(
      req.user!,
      unitId,
      uploadId,
      parseBody(InlineUploadSchema, body),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Record an uploaded clip after verifying what landed (staff).' })
  async record(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('unitId') unitId: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const dto = parseBody(RecordVideoSchema, body);
    // A phone cannot show a log, and a screenshot is a poor measuring device
    // (2026-11-26). When the recorder carries ?timings=1 it sends its own numbers
    // with the take; they land here, where the gate can read them afterwards.
    if (dto.timings !== undefined) {
      this.logger.log(`[site-video-timings] unit=${unitId} ${JSON.stringify(dto.timings)}`);
    }
    const result = await this.service.record(req.user!, unitId, dto);
    // 201 for a new row, 200 when this exact take was already saved.
    res.status(result.replayed ? 200 : 201);
    return result.photo;
  }

  @Delete('pending/:uploadId')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel an upload that was never recorded (idempotent).' })
  async cancel(
    @Req() req: AuthedRequest,
    @Param('unitId') unitId: string,
    @Param('uploadId') uploadId: string,
  ): Promise<{ cancelled: boolean }> {
    return this.service.cancel(req.user!, unitId, uploadId);
  }
}
