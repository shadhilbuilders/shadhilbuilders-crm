// Internal WhatsApp notification trigger.
//
// POST /api/whatsapp/internal-notify - sends the `internal_enquiry_notification`
// template to the ops/test recipient (env WA_RECIPIENT). This gives
// the smoke-test path a real endpoint to hit (from a script, curl, or the
// webhook test) and the delivery/status callback flows back through the
// WhatsApp webhook.
import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { Public } from '../auth/public.decorator';
import {
  InternalNotifyService,
  type InternalNotifyResult,
} from './internal-notify.service';

@ApiTags('whatsapp')
@Controller('whatsapp/internal-notify')
export class WhatsappInternalNotifyController {
  constructor(
    @Inject(InternalNotifyService)
    private readonly internalNotify: InternalNotifyService,
  ) {}

  // @Public() + no signature guard: this is an internal trigger endpoint.
  // For a smoke test the caller hits it directly (curl). In production it
  // should sit behind the JWT guard / an api token; for now it is the
  // explicitly-offered test trigger.
  @Public()
  @Post()
  @HttpCode(200)
  async trigger(
    @Body()
    body: {
      name?: string;
      phone?: string;
      project?: string;
      message?: string;
    } = {},
  ): Promise<InternalNotifyResult> {
    const parameters = InternalNotifyService.enquiryParams(body);
    return this.internalNotify.send(parameters);
  }
}
