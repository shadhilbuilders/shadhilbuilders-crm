// Chat module - message history + send for the Lead detail page.
//
// T-CHAT (2026-09-07): replaces the Phase-1 stub. The web page
// already wires to GET /api/chat/:leadId and POST /api/chat/send via
// useMessages/useSendMessage; this module lights them up.
//
// ChatService doesn't depend on LeadsService today (chat messages
// don't drive lead state transitions in Phase 1), so no
// LeadsModule import is needed. If T-CHAT ever needs to drive a
// lead transition (e.g. inbound WA message that confirms a visit),
// add LeadsModule to imports and @Inject(LeadsService) on the
// service constructor.
import { Module } from '@nestjs/common';

import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

@Module({
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
