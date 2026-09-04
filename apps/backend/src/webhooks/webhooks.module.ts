// Webhooks module — inbound from WhatsApp (Meta) and FreJun (telephony).
//
// T-WEBHOOK (2026-09-07): the POST /whatsapp handler is a 202-stub
// per the demo-runbook priority order for cuts. The full WA
// integration (signature verification, dedup, lead creation,
// outbound reply) ships in Week 7 — see the TODO in
// webhooks.controller.ts.
import { Module } from '@nestjs/common';

import { WebhooksController } from './webhooks.controller';

@Module({ controllers: [WebhooksController] })
export class WebhooksModule {}
