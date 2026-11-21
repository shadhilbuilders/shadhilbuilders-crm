// Push controller - web push subscription + VAPID public key.
//
// Mirrors the notifications controller pattern (@Inject with explicit token,
// parseBody helper, @ApiTags + @ApiBearerAuth).
//
// Endpoints:
//   - GET  /api/push/vapid-key   - the VAPID public key the web app needs to
//                                  subscribe (null when push is disabled).
//   - POST /api/push/subscribe   - register/upsert a push subscription.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { RegisterPushDtoSchema, type RegisterPushDto } from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { PushService, type PushStatusResult, type PushSubscribeResult } from './push.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    );
  }
  return result.data;
}

@ApiTags('push')
@ApiBearerAuth('jwt')
@Controller('push')
export class PushController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  @Get('vapid-key')
  @ApiOperation({
    summary: 'Return the VAPID public key for web push subscription.',
  })
  async vapidKey(): Promise<{ publicKey: string | null }> {
    return { publicKey: this.push.publicKey };
  }

  @Get('status')
  @ApiQuery({ name: 'endpoint', required: true, description: 'The browser push endpoint.' })
  @ApiOperation({
    summary: 'Whether the server still holds this endpoint under the current VAPID key.',
    description:
      'The browser knowing it has a subscription says nothing about whether the server can ' +
      'deliver to it: the row may have been pruned on 404/410, dropped after a VAPID key ' +
      'rotation, or never written because the subscribe POST failed. This is the only ' +
      'authoritative answer, and the client uses it to offer "re-register this device".',
  })
  async status(
    @Req() req: AuthedRequest,
    @Query('endpoint') endpoint?: string,
  ): Promise<PushStatusResult> {
    const value = endpoint?.trim();
    if (!value) throw new BadRequestException('endpoint: required');
    return this.push.status(req.user!, value);
  }

  @Post('subscribe')
  @ApiOperation({
    summary: 'Register/upsert a push subscription for the current user.',
  })
  async subscribe(@Req() req: AuthedRequest, @Body() body: unknown): Promise<PushSubscribeResult> {
    const dto: RegisterPushDto = parseBody(RegisterPushDtoSchema, body);
    return this.push.subscribe(req.user!, dto);
  }
}
