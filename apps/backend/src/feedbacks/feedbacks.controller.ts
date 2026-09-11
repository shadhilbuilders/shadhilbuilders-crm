// Feedback - controllers.
//
// Two controllers in one file, both backed by FeedbacksService:
//
//   1. FeedbackAdminController (@Controller('feedback')) - ADMIN/OWNER-only
//      triage surface. Routes ride the global JwtAuthGuard (a valid JWT is
//      required); RLS (feedback_select_admin / feedback_update_admin) is the
//      real authorization wall below the JWT.
//        GET   /api/feedback?status=...&limit=...&cursor=...
//        PATCH /api/feedback/:id   body: { status }
//
//   2. FeedbackPublicController (@Controller('public')) - the anonymous
//      landing-page path. @Public() opts out of the global JWT guard;
//      @UseGuards(ApiKeyGuard) validates `x-api-key` instead.
//        POST  /api/public/feedback
//
// parseBody / parseQuery helpers mirror the whatsapp-unknown-contacts and
// notifications controllers (ZodError -> 400 with a readable message).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateFeedbackDtoSchema,
  FeedbackListQuerySchema,
  UpdateFeedbackStatusDtoSchema,
  type CreateFeedbackDto,
  type FeedbackListQuery,
  type UpdateFeedbackStatusDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { Public } from '../auth/public.decorator';

import { ApiKeyGuard } from './api-key.guard';
import {
  FeedbacksService,
  type CreateFeedbackResult,
  type FeedbackListResult,
  type UpdateFeedbackResult,
} from './feedbacks.service';

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

function parseQuery<T>(
  schema: z.ZodType<T>,
  query: Record<string, string | string[] | undefined>,
): T {
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) normalized[k] = v[0];
    else if (v !== undefined) normalized[k] = v;
  }
  const result = schema.safeParse(normalized);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

// ────────────────────────────────────────────────────────────────────────────
// Admin triage controller
// ────────────────────────────────────────────────────────────────────────────

@ApiTags('feedback')
@ApiBearerAuth()
@Controller('feedback')
export class FeedbackAdminController {
  constructor(
    @Inject(FeedbacksService) private readonly service: FeedbacksService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List feedback for triage (ADMIN/OWNER only)' })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<FeedbackListResult> {
    const dto: FeedbackListQuery = parseQuery(FeedbackListQuerySchema, query);
    return this.service.list(req.user!, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update feedback triage status (ADMIN/OWNER only). Only status may change - feedback content is immutable.',
  })
  async updateStatus(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<UpdateFeedbackResult> {
    const dto: UpdateFeedbackStatusDto = parseBody(
      UpdateFeedbackStatusDtoSchema,
      body,
    );
    return this.service.updateStatus(req.user!, id, dto);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Public submit controller (landing page)
// ────────────────────────────────────────────────────────────────────────────

@ApiTags('public')
@Controller('public')
export class FeedbackPublicController {
  constructor(
    @Inject(FeedbacksService) private readonly service: FeedbacksService,
  ) {}

  @Public()
  @UseGuards(new ApiKeyGuard('FEEDBACK_API_KEY'))
  @Post('feedback')
  @ApiOperation({
    summary:
      'Submit feedback from the landing page (API-key-gated, no JWT). Captures ipAddress + userAgent server-side.',
  })
  async create(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<CreateFeedbackResult> {
    // Extract IP + UA from the raw Express request (the @Req() is the raw
    // Request here - the guard does not populate it, but the original
    // Express request object is available with headers/ip).
    const rawReq = req as unknown as {
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    };
    const forwarded = (rawReq.headers?.['x-forwarded-for'] as
      | string
      | undefined);
    const ip = (forwarded?.split(',')[0]?.trim() || rawReq.ip || 'unknown').replace(
      /^::ffff:/,
      '',
    );
    const userAgentHeader = rawReq.headers?.['user-agent'];
    const userAgent =
      typeof userAgentHeader === 'string' ? userAgentHeader : undefined;

    const dto: CreateFeedbackDto = parseBody(CreateFeedbackDtoSchema, body);
    return this.service.publicSubmit(dto, { ip, userAgent: userAgent ?? '' });
  }
}
