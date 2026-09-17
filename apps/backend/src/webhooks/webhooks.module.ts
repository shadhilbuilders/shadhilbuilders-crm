// Webhooks module - inbound from WhatsApp (Meta) and FreJun (telephony).
//
// T-E2b: the POST /whatsapp handler processes inbound WhatsApp events
// (status updates, text from known/unknown numbers, and MEDIA 2B inbound
// image/video/audio/document). The controller injects WhatsAppClient (to
// download inbound media) + StorageProvider (to persist it) and forwards to
// the chat/leads paths.
import { Module } from '@nestjs/common';

import { WhatsAppClient } from '../whatsapp/whatsapp.client';

import { WebhooksController } from './webhooks.controller';

@Module({
  controllers: [WebhooksController],
  providers: [
    // Construct once from env (same factory the WhatsappModule uses) so the
    // webhook controller can download inbound media.
    {
      provide: WhatsAppClient,
      useFactory: () => WhatsAppClient.fromEnv(),
    },
  ],
})
export class WebhooksModule {}
