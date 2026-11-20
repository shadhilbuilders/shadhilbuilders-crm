// Public invite routes (2026-11-20).
//
// These are the only unauthenticated endpoints this feature adds. Their
// credential is the invite TOKEN in the path, not a JWT - which is exactly
// the @Public() case AGENTS.md allows.
//
// Deliberate properties:
//   * The token is the secret. Nothing here echoes it back, and the preview
//     returns no user ids (see PublicInvitePreviewSchema).
//   * A malformed token is rejected before any query (looksLikeInviteToken),
//     so this cannot be used to probe the token index with arbitrary strings.
//   * Both routes are rate-limited per IP. The limit is in-memory, matching
//     the existing `rateLimitMap` precedent in realtime.service.ts: this is a
//     single-process backstop against a naive scanner, not a distributed
//     quota. The real bound is that a valid token is 256 bits of entropy.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AcceptInviteDtoSchema,
  type AcceptInviteDto,
  type AcceptInviteResult,
  type PublicInvitePreview,
} from '@shadhil/api-types';
import { z } from 'zod';

import { Public } from '../auth/public.decorator';

import { InvitesService } from './invites.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    );
  }
  return result.data;
}

/**
 * Per-IP sliding window. 30 requests per minute is generous for a human
 * opening one link (the page does one preview + one accept) and cheap enough
 * that a scanner cannot sweep the token space at any useful rate.
 */
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();

function assertWithinRateLimit(ip: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (entry === undefined || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX) {
    throw new BadRequestException('Too many requests. Please try again in a minute.');
  }
}

@ApiTags('public-invites')
@Controller('public/invites')
export class InvitesPublicController {
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @Public()
  @Get(':token')
  @ApiOperation({
    summary:
      'Preview an invite from its token (no JWT). Returns the org/role/team being ' +
      'joined plus the pinned email and phone. 404 for an unknown token, 410 for ' +
      'expired / revoked / already accepted.',
  })
  async preview(
    @Param('token') token: string,
    @Ip() ip: string,
  ): Promise<PublicInvitePreview> {
    assertWithinRateLimit(ip);
    return this.invites.preview(token);
  }

  @Public()
  @Post(':token/accept')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Accept an invite (no JWT): sets your own name, phone and password and provisions ' +
      'the account. The email is pinned on the invite - there is no email field. A provided ' +
      'phone CORRECTS the invite number and the change is audited.',
  })
  async accept(
    @Param('token') token: string,
    @Body() body: unknown,
    @Ip() ip: string,
  ): Promise<AcceptInviteResult> {
    assertWithinRateLimit(ip);
    const dto: AcceptInviteDto = parseBody(AcceptInviteDtoSchema, body);
    return this.invites.accept(token, dto);
  }
}
