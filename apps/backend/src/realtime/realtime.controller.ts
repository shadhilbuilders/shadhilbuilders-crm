// Realtime controller — 3 SSE streams (chat, notifications, audit) with
// stream-ticket auth + Last-Event-ID resume.
//
// T-E2 (Week 6, 2026-09-04).
//
// FRAMEWORK NOTES (hard-won, verified 2026-09-04 — do not "simplify"):
//   1. Nest's @Sse() serializer auto-numbers `id:` when the message's id
//      is nil (SseStream.writeMessage) — always set id on real events.
//   2. rxjs does NOT flatten promise-resolved arrays: mergeMap(async ()
//      => [{...}, {...}]) emits the ARRAY as one value. Two-stage
//      mergeMap (await, then project-to-self) flattens. Verified.
//   3. A raw @Res() async handler: synchronous writes reach the socket,
//      setInterval writes do not (Nest finalizes the response once the
//      awaited handler resolves).
//   => Final shape: SYNC @Sse() handler + defer(async setup) + two-stage
//      mergeMap poll. All async work lives inside the observable.
//
// Every event carries `id: <row-cuid>`; clients reconnect with
// Last-Event-ID (via ?lastEventId=); the controller replays missed rows
// before resuming live. Heartbeats every 15s keep proxies alive.
import { Controller, Get, Inject, Param, Query, Sse } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { defer, interval, map, merge, mergeMap, Observable } from 'rxjs';
import type { PrismaClient } from '@shadhil/database';

import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.module';
import { RealtimeService } from './realtime.service';

const DB_TICK_MS = 1_000;
const HEARTBEAT_MS = 15_000;

type SseEvent = {
  data: unknown;
  id?: string;
};

type FetchEvents = () => Promise<SseEvent[]>;

/**
 * Verified working stream shape: interval → mergeMap(async fetch) →
 * mergeMap(project array to itself, which rxjs flattens) → frames;
 * pings merged in. The double cast is required because TS types the
 * first mergeMap's output as SseEvent[] even though the second
 * flattens it at runtime.
 */
function pollStream(fetchEvents: FetchEvents): Observable<SseEvent> {
  const ticks = interval(DB_TICK_MS).pipe(
    mergeMap(() => fetchEvents()),
    mergeMap((arr: SseEvent[]) => arr),
  );
  const pings = interval(HEARTBEAT_MS).pipe(
    map(() => ({ data: { type: 'ping', ts: Date.now() } })),
  );
  return merge(ticks, pings) as unknown as Observable<SseEvent>;
}

@ApiTags('realtime')
@Controller()
export class RealtimeController {
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /** Chat stream for one lead. Ticket channel must be "chat:<leadId>". */
  @Public()
  @Sse('sse/chat/:leadId')
  chat(
    @Param('leadId') leadId: string,
    @Query('ticket') ticket: string,
    @Query('lastEventId') lastEventIdQs: string | undefined,
  ): Observable<SseEvent> {
    const lastEventId =
      typeof lastEventIdQs === 'string' && lastEventIdQs.length > 0 ? lastEventIdQs : null;

    // defer(): async setup (ticket consume + replay anchor) runs on
    // SUBSCRIBE, keeping the handler sync (framework note #3).
    return defer(async () => {
      await this.realtime.consumeTicket(ticket, `chat:${leadId}`);
      let lastSeenAt = new Date(0);
      if (lastEventId !== null) {
        const anchor = await this.client.message.findUnique({
          where: { id: lastEventId },
          select: { createdAt: true },
        });
        if (anchor !== null) lastSeenAt = anchor.createdAt;
      }
      return { lastSeenAt };
    }).pipe(
      mergeMap(({ lastSeenAt }) =>
        pollStream(async () => {
          const rows = await this.client.message.findMany({
            where: { leadId, createdAt: { gt: lastSeenAt } },
            orderBy: { createdAt: 'asc' },
            take: 50,
          });
          if (rows.length > 0) {
            lastSeenAt = rows[rows.length - 1]!.createdAt;
          }
          return rows.map((m) => ({
            id: m.id,
            data: {
              id: m.id,
              leadId: m.leadId,
              direction: m.direction,
              channel: m.channel,
              body: m.body,
              mediaUrl: m.mediaUrl,
              createdAt: m.createdAt.toISOString(),
            },
          }));
        }),
      ),
    );
  }

  /** Notifications stream for the ticket owner. */
  @Public()
  @Sse('sse/notifications')
  notifications(
    @Query('ticket') ticket: string,
    @Query('lastEventId') lastEventIdQs: string | undefined,
  ): Observable<SseEvent> {
    const lastEventId =
      typeof lastEventIdQs === 'string' && lastEventIdQs.length > 0 ? lastEventIdQs : null;

    return defer(async () => {
      const { userId } = await this.realtime.consumeTicket(ticket, 'notifications');
      let lastSeenAt = new Date(0);
      if (lastEventId !== null) {
        const anchor = await this.client.notification.findUnique({
          where: { id: lastEventId },
          select: { createdAt: true },
        });
        if (anchor !== null) lastSeenAt = anchor.createdAt;
      }
      return { userId, lastSeenAt };
    }).pipe(
      mergeMap(({ userId, lastSeenAt }) =>
        pollStream(async () => {
          const rows = await this.client.notification.findMany({
            where: { userId, createdAt: { gt: lastSeenAt } },
            orderBy: { createdAt: 'asc' },
            take: 50,
          });
          if (rows.length > 0) {
            lastSeenAt = rows[rows.length - 1]!.createdAt;
          }
          return rows.map((n) => ({
            id: n.id,
            data: {
              id: n.id,
              userId: n.userId,
              type: n.type,
              title: n.title,
              body: n.body,
              leadId: n.leadId,
              read: n.read,
              createdAt: n.createdAt.toISOString(),
            },
          }));
        }),
      ),
    );
  }

  /** Audit stream for the ticket owner (own rows; ADMIN/OWNER see all). */
  @Public()
  @Sse('sse/audit')
  audit(
    @Query('ticket') ticket: string,
    @Query('lastEventId') lastEventIdQs: string | undefined,
  ): Observable<SseEvent> {
    const lastEventId =
      typeof lastEventIdQs === 'string' && lastEventIdQs.length > 0 ? lastEventIdQs : null;

    return defer(async () => {
      const { userId } = await this.realtime.consumeTicket(ticket, 'audit');
      const owner = await this.client.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      const seeAll = owner?.role === 'ADMIN' || owner?.role === 'OWNER';
      let lastSeenAt = new Date(0);
      if (lastEventId !== null) {
        const anchor = await this.client.auditLog.findUnique({
          where: { id: lastEventId },
          select: { createdAt: true },
        });
        if (anchor !== null) lastSeenAt = anchor.createdAt;
      }
      return { userId, seeAll, lastSeenAt };
    }).pipe(
      mergeMap(({ userId, seeAll, lastSeenAt }) =>
        pollStream(async () => {
          const rows = await this.client.auditLog.findMany({
            where: {
              createdAt: { gt: lastSeenAt },
              ...(seeAll ? {} : { userId }),
            },
            orderBy: { createdAt: 'asc' },
            take: 50,
          });
          if (rows.length > 0) {
            lastSeenAt = rows[rows.length - 1]!.createdAt;
          }
          return rows.map((a) => ({
            id: a.id,
            data: {
              id: a.id,
              userId: a.userId,
              action: a.action,
              entityType: a.entityType,
              entityId: a.entityId,
              before: a.before,
              after: a.after,
              reason: a.reason,
              createdAt: a.createdAt.toISOString(),
            },
          }));
        }),
      ),
    );
  }
}