// Realtime SSE module — 3 channels: lead chat, notifications, visit status.
//
// Eng review A9: every SSE event has an `id:` field that maps to the
// source row's id. Clients reconnect with `Last-Event-ID` header; the
// server replays missed events from Postgres.
//
// Phase 1: routes registered, full SSE handler lands in Week 6.
import { Controller, Get, Module, Param, Sse } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { interval, map } from 'rxjs';

@ApiTags('realtime')
@ApiBearerAuth('jwt')
@Controller()
class RealtimeController {
  // Heartbeat endpoint — every SSE connection pings every 15s. Real SSE
  // streams (lead chat, notifications) wire up in Phase 2 with Last-Event-ID
  // resume from Postgres chat_message table (eng review A9).
  @Sse('sse/ping')
  ping(): Observable<{ data: { type: 'ping'; ts: number } }> {
    return interval(15_000).pipe(
      map(() => ({ data: { type: 'ping' as const, ts: Date.now() } })),
    );
  }

  @Get('leads/:id/stream/info')
  leadStreamInfo(@Param('id') id: string): { leadId: string; status: string; phase: number } {
    return { leadId: id, status: 'wired', phase: 1 };
  }
}

@Module({ controllers: [RealtimeController] })
export class RealtimeModule {}
