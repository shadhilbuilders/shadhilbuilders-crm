// T-E2b follow-up queue - module.
//
// Wires the controller + service. LeadsModule is imported because
// the service injects LeadsService (for the convert flow that
// creates a Lead in-transaction).
import { Module } from '@nestjs/common';

import { LeadsModule } from '../leads/leads.module';

import { WhatsappUnknownContactsController } from './whatsapp-unknown-contacts.controller';
import { WhatsappUnknownContactsService } from './whatsapp-unknown-contacts.service';

@Module({
  imports: [LeadsModule],
  controllers: [WhatsappUnknownContactsController],
  providers: [WhatsappUnknownContactsService],
  exports: [WhatsappUnknownContactsService],
})
export class WhatsappUnknownContactsModule {}
