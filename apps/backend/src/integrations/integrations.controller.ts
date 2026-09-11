// Integrations controller - read-only ops telemetry for the webhook pipeline.
//
// Mirrors the audit controller pattern:
//   - @Inject with explicit token (tsx/esbuild doesn't emit design:paramtypes)
//   - parseQuery coercing numeric params (the BFF forwards them as strings)
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//   - role guard lives in the SERVICE (403), matching the audit convention
//     where the global JwtAuthGuard handles auth only.
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  WhatsAppDeliveryQuerySchema,
  WebhookEventsQuerySchema,
  type WhatsAppDeliveryQuery,
  type WebhookEventsQuery,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import {
  IntegrationsService,
  type WhatsAppDeliveryListResult,
  type WebhookEventsListResult,
} from './integrations.service';

function parseQuery<T>(schema: z.ZodType<T>, query: Record<string, unknown>): T {
  const result = schema.safeParse(query);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

@ApiTags('integrations')
@ApiBearerAuth('jwt')
@Controller('integrations')
export class IntegrationsController {
  constructor(
    @Inject(IntegrationsService)
    private readonly integrations: IntegrationsService,
  ) {}

  @Get('webhook-events')
  @ApiOperation({
    summary:
      'List raw inbound webhook events (ADMIN/OWNER). Confirms Meta ' +
      'payloads reached the API and how they were processed.',
  })
  async webhookEvents(
    @Req() req: AuthedRequest,
    @Query() q: Record<string, unknown>,
  ): Promise<WebhookEventsListResult> {
    const limit =
      typeof q['limit'] === 'string' ? Number.parseInt(q['limit'], 10) : undefined;
    const offset =
      typeof q['offset'] === 'string' ? Number.parseInt(q['offset'], 10) : undefined;
    const processed =
      q['processed'] === 'true' ? true : q['processed'] === 'false' ? false : undefined;
    const dto: WebhookEventsQuery = parseQuery(
      WebhookEventsQuerySchema,
      { source: q['source'], processed, limit, offset },
    );
    return this.integrations.listWebhookEvents(req.user!, dto);
  }

  @Get('whatsapp-delivery')
  @ApiOperation({
    summary:
      'List the WhatsApp outbound delivery feed (ADMIN/OWNER): status, ' +
      'attempts, lastError, wamid - reflects the Meta status webhook.',
  })
  async whatsappDelivery(
    @Req() req: AuthedRequest,
    @Query() q: Record<string, unknown>,
  ): Promise<WhatsAppDeliveryListResult> {
    const limit =
      typeof q['limit'] === 'string' ? Number.parseInt(q['limit'], 10) : undefined;
    const offset =
      typeof q['offset'] === 'string' ? Number.parseInt(q['offset'], 10) : undefined;
    const dto: WhatsAppDeliveryQuery = parseQuery(
      WhatsAppDeliveryQuerySchema,
      { status: q['status'], limit, offset },
    );
    return this.integrations.listWhatsAppDelivery(req.user!, dto);
  }
}
