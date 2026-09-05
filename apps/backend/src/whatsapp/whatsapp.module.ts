// T-E2b: WhatsApp module — wires the client + outbound service.
//
// The module is intentionally thin: the actual logic lives in
// `whatsapp.client.ts` (Meta API call) and `outbound.service.ts`
// (outbox + lease). The cron processor (apps/backend/src/cron/)
// imports OutboundService directly and runs it on a schedule;
// this module is for DI + the chat service's `enqueue()` call.

import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { OutboundService } from './outbound.service';
import { WhatsAppClient } from './whatsapp.client';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [
    // WhatsAppClient is constructed once at module init from env vars
    // (loud failure if creds missing — fail-fast, per skill rule).
    {
      provide: WhatsAppClient,
      useFactory: () => WhatsAppClient.fromEnv(),
    },
    OutboundService,
  ],
  exports: [OutboundService, WhatsAppClient],
})
export class WhatsappModule {}
