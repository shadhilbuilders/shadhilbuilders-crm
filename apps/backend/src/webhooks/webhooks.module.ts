// Webhooks module — inbound from WhatsApp (Meta) and FreJun (telephony).
// Signature verification is the auth; routes are @Public().
//
// Phase 1: routes are wired but handlers land in Phase 2.
import { Controller, Get, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

@ApiTags('webhooks')
@Controller('webhooks')
class WebhooksController {
  @Public()
  @Get('whatsapp')
  verify(): { status: 'ok' } {
    // Meta sends a GET to verify the webhook URL — return challenge.
    // Real implementation lands in Phase 2.
    return { status: 'ok' };
  }

  @Public()
  @Post('whatsapp')
  whatsappInbound(): { message: string; phase: number } {
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
