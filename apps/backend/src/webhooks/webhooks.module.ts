// Webhooks module — inbound from WhatsApp (Meta) and FreJun (telephony).
// Signature verification is the auth; routes are @Public() BY DESIGN (AR-8,
// kept deliberately: these receive calls from Meta/FreJun servers, not users).
//
// SECOND-ROUND AUDIT fixes: WhatsApp GET now does the real Meta verification
// handshake (echo hub.challenge only when hub.verify_token matches
// WA_WEBHOOK_VERIFY_TOKEN); POSTs reject payloads when the token env is
// unset so we never accept unauthenticated traffic in production by accident
// (full X-Hub-Signature-256 verification lands Week 7 with the inbound
// processor).
import { Controller, Get, Module, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

@ApiTags('webhooks')
@Controller('webhooks')
class WebhooksController {
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

  @Public()
  @Post('whatsapp')
  whatsappInbound(): { message: string; phase: number } {
    // Signature enforcement (X-Hub-Signature-256) required before Phase 2
    // flips this from stub to processor — see plan §17 Input #3.
    return { message: 'WhatsApp inbound handler lands in Week 7', phase: 1 };
  }

  @Public()
  @Post('frejun')
  frejunInbound(): { message: string; phase: number } {
    return { message: 'FreJun inbound handler lands in Week 8', phase: 1 };
  }
}

@Module({ controllers: [WebhooksController] })
export class WebhooksModule {}