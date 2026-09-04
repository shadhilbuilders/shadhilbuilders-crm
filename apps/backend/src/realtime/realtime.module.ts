// Realtime SSE module — 3 channels: lead chat, notifications, audit.
//
// T-E2 (Week 6, 2026-09-04): replaces the Phase-1 stub with a real
// ticket-mint + Last-Event-ID resume flow.
//
//   POST /api/realtime/ticket        — mint a 5-minute single-use ticket
//   GET  /api/sse/chat/:leadId       — Message stream (ticket = "chat:<id>")
//   GET  /api/sse/notifications      — Notification stream (ticket = "notifications")
//   GET  /api/sse/audit              — AuditLog stream (ticket = "audit")
//   GET  /api/sse/ping               — heartbeat-only canary (no ticket)
//
// Every real event carries `id: <row-cuid>`; clients reconnect with
// Last-Event-ID (via ?lastEventId= for EventSource compatibility) and the
// controller replays missed rows from Postgres before resuming live.
// Heartbeats every 15s keep proxies from timing out idle connections.
import { Body, Controller, Get, Inject, Module, Post, Req, Sse } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { interval, map, Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/jwt-auth.guard';
import type { MintTicketDto, MintTicketResponse } from '@shadhil/api-types';

import { Public } from '../auth/public.decorator';
import { RealtimeController } from './realtime.controller';
import { RealtimeService } from './realtime.service';

@ApiTags('realtime')
@ApiBearerAuth('jwt')
@Controller('realtime')
export class RealtimeTicketController {
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  @Post('ticket')
  @ApiOperation({
    summary:
      'Mint a 5-minute single-use stream ticket for an SSE channel (notifications | audit | chat:<leadId>).',
  })
  async mint(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<MintTicketResponse> {
    // Body parse: the shared Zod schema in api-types (MintTicketDtoSchema)
    // is applied in the service via parseChannel + channel checks. The
    // minimal shape check here mirrors the parseBody helper pattern.
    const raw = body as { channel?: unknown };
    if (
      raw === null ||
      typeof raw !== 'object' ||
      typeof raw.channel !== 'string' ||
      raw.channel.length === 0
    ) {
      const err = new Error('body.channel must be a non-empty string');
      (err as Error & { status?: number }).status = 400;
      throw err;
    }
    return this.realtime.mintTicket(req.user!, { channel: raw.channel });
  }
}

// Minimal canary: pure-interval SSE with no DB work. If THIS doesn't
// flush frames to the socket, the problem is transport-level (compression
// middleware, proxy), not the stream construction.
@ApiTags('realtime')
@Controller()
export class RealtimePingController {
  @Public()
  @Sse('sse/ping')
  ping(): Observable<{ data: { type: 'ping'; ts: number } }> {
    return interval(2_000).pipe(map(() => ({ data: { type: 'ping' as const, ts: Date.now() } })));
  }
}

@Module({
  controllers: [RealtimeTicketController, RealtimeController, RealtimePingController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}