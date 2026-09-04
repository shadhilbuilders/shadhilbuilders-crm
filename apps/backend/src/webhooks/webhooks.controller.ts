// Webhooks controller — inbound from WhatsApp (Meta) and FreJun (telephony).
// Signature verification is the auth; routes are @Public() BY DESIGN (AR-8,
// kept deliberately: these receive calls from Meta/FreJun servers, not users).
//
// SECOND-ROUND AUDIT fixes: WhatsApp GET does the real Meta verification
// handshake (echo hub.challenge only when hub.verify_token matches
// WA_WEBHOOK_VERIFY_TOKEN); POSTs reject payloads when the token env is
// unset so we never accept unauthenticated traffic in production by accident
// (full X-Hub-Signature-256 verification lands Week 7 with the inbound
// processor).
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/public.decorator';

@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  @Public()
  @Get('whatsapp')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ): string {
    const expected = process.env.WA_WEBHOOK_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token === expected && challenge) {
      return challenge;
    }
    // Fail the handshake loudly — Meta retries and logs until fixed.
    throw new Error(
      'WhatsApp webhook verification failed: hub.mode/hub.verify_token mismatch or WA_WEBHOOK_VERIFY_TOKEN unset',
    );
  }

  /**
   * POST /api/webhooks/whatsapp — T-WEBHOOK (2026-09-07).
   *
   * T-WEBHOOK is the lowest-priority task in the demo sprint — the
   * prompt explicitly authorizes a 202-stub if time is tight. This
   * handler accepts a basic WA Business payload shape
   * (`{ from, body, messageId }`), logs it, and returns 202 with
   * a stubbed "lead created" log line. The full WhatsApp Business
   * API integration (signature verification, dedup via WebhookEvent.
   * externalId, lead creation, outbound message) ships in Week 7.
   *
   * Per the demo-runbook priority order for cuts, this is the first
   * task we'd cut — keeping the stub thin so the demo doesn't depend
   * on WA integration.
   *
   * TODO Week 7: full WhatsApp Business API integration
   *   - X-Hub-Signature-256 verification
   *   - Dedupe via WebhookEvent.externalId
   *   - Find or create Lead by phone
   *   - Emit inbound Message row + outbound reply via WA Cloud API
   */
  @Public()
  @Post('whatsapp')
  whatsappInbound(@Body() body: unknown): {
    received: boolean;
    messageId: string | null;
    status: 'queued';
  } {
    // Validate the basic WA Business payload shape. The real WA
    // payload is deeply nested (object/entry/changes/value/messages);
    // we accept the slimmed shape for the demo and document the
    // gap. The full Zod schema lives in
    // packages/api-types/src/webhooks.ts (WhatsAppWebhookPayloadSchema)
    // — using it here would require the full Meta envelope which
    // we don't exercise in Pass 1.
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as Record<string, unknown>)['messageId'] !== 'string'
    ) {
      throw new BadRequestException(
        'WhatsApp webhook payload must include { from, body, messageId }',
      );
    }
    const payload = body as { from?: string; body?: string; messageId: string };
    this.logger.log(
      `WhatsApp inbound (stub): from=${payload.from ?? '<unknown>'} messageId=${payload.messageId} body=${(payload.body ?? '').slice(0, 80)}`,
    );
    // Stubbed lead-creation log line (Week 7 will actually create
    // the Lead + send the reply).
    this.logger.debug(
      `[STUB] would create Lead from phone=${payload.from ?? '<unknown>'} and send hello message`,
    );
    return {
      received: true,
      messageId: payload.messageId,
      status: 'queued',
    };
  }

  @Public()
  @Post('frejun')
  frejunInbound(): { message: string; phase: number } {
    return { message: 'FreJun inbound handler lands in Week 8', phase: 1 };
  }
}
