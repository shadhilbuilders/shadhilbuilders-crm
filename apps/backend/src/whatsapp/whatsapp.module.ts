// T-E2b: WhatsApp module - wires the client + outbound service +
// outbound cron processor.
//
// The module is intentionally thin: the actual logic lives in
// `whatsapp.client.ts` (Meta API call), `outbound.service.ts` (outbox
// + lease + sendOne), and `outbound.cron.ts` (5-second tick that
// claims and dispatches). This module is for DI + the chat service's
// `enqueue()` call.
import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { InternalNotifyService } from './internal-notify.service';
import { OutboundCronService } from './outbound.cron';
import { OutboundService } from './outbound.service';
import { WhatsAppClient } from './whatsapp.client';
import { WhatsappInternalNotifyController } from './whatsapp.internal-notify.controller';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [WhatsappInternalNotifyController],
  providers: [
    // WhatsAppClient is constructed once at module init from env vars
    // (loud failure if creds missing - fail-fast, per skill rule).
    {
      provide: WhatsAppClient,
      useFactory: () => WhatsAppClient.fromEnv(),
    },
    OutboundService,
    InternalNotifyService,
    // T-E2b: cron processor that drains the outbox. The @Cron
    // decorator fires every 5s in production. Tests drive
    // `runOnce()` directly to avoid waiting on the schedule.
    OutboundCronService,
  ],
  exports: [OutboundService, WhatsAppClient, InternalNotifyService],
})
export class WhatsappModule {}
