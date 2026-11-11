// T-E2b: WhatsApp module - wires the client + outbound service +
// outbound cron processor.
//
// The module is intentionally thin: the actual logic lives in
// `whatsapp.client.ts` (Meta API call), `outbound.service.ts` (outbox
// + lease + sendOne), and `outbound.cron.ts` (5-second tick that
// claims and dispatches). This module is for DI + the chat service's
// `enqueue()` call.
//
// The old internal-notify path (config + service + public
// POST /api/whatsapp/internal-notify) was removed 2026-11-11. It was an
// unauthenticated "send a WhatsApp template" surface built on a template that
// belongs to the LANDING PAGE (`internal_enquiry_notification`), and its
// parameter contract never matched that approved body: the CRM passed
// `project` into {{3}} and the free-text message into {{4}}, where the body
// reads "interested in: {{3}}" and "Enquiry reference: {{4}}", so every alert
// rendered "Enquiry reference: <customer's message>".
//
// Ops alerting for this app, if it comes back, needs its own template and a
// parameter contract that matches it — behind an authenticated trigger.
import { Global, Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { OutboundCronService } from './outbound.cron';
import { OutboundService } from './outbound.service';
import { WhatsAppClient } from './whatsapp.client';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    // WhatsAppClient is constructed once at module init from env vars
    // (loud failure if creds missing - fail-fast, per skill rule).
    {
      provide: WhatsAppClient,
      useFactory: () => WhatsAppClient.fromEnv(),
    },
    OutboundService,
    // T-E2b: cron processor that drains the outbox. The @Cron
    // decorator fires every 5s in production. Tests drive
    // `runOnce()` directly to avoid waiting on the schedule.
    OutboundCronService,
  ],
  exports: [OutboundService, WhatsAppClient],
})
export class WhatsappModule {}
