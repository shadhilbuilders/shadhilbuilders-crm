// Realtime service - stream-ticket mint + consume.
//
// T-E2 (Week 6, 2026-09-04): replaces the Phase-1 SSE stub with a real
// ticket-authenticated SSE layer. Flow:
//
//   1. Browser POSTs /api/realtime/ticket with { channel: "chat:<id>" }.
//   2. This service mints a 5-minute StreamTicket row, returns the cuid.
//   3. Browser opens GET /api/sse/<channel>?ticket=<cuid>.
//   4. The controller consumes (deletes) the ticket on connect and
//      starts the stream.
//
// Why tickets instead of JWT on the SSE path: the browser's EventSource
// cannot set Authorization headers (spec limitation). The ticket IS the
// auth - unguessable cuid, bound to (user, channel), single-use, and
// expires in 5 minutes so leakage is bounded.
//
// Channel access rules (enforced at mint time):
//   - "notifications" - always allowed (the row userId = actor.sub)
//   - "audit"         - allowed for all roles; the stream filters rows
//                       per the same policy the REST list uses
//                       (admin/owner see all, others see own rows)
//   - "chat:<leadId>" - allowed only if the actor could read the lead
//                       (same RLS visibility the REST list enforces:
//                       owner, same-team, or admin/owner)
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type PrismaClient,
  withRlsContext, rlsContextFrom,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { MintTicketDto, MintTicketResponse } from '@shadhil/api-types';

import { parseChannel } from '@shadhil/api-types';
import { PrismaService } from '../prisma/prisma.module';

const TICKET_TTL_MS = 5 * 60 * 1000; // 5 minutes

// T-PERF-2 #3: per-user rate limit on ticket mint. Two windows: 10/min
// and 60/hour. In-memory Map with lazy TTL cleanup. Loses state on
// restart, which is fine for a single-instance deployment; swap to
// Redis when we go multi-instance.
const TICKETS_PER_MINUTE = 10;
const TICKETS_PER_HOUR = 60;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface RateLimitWindow {
  minute: number[]; // timestamps (ms) of recent mints in the past minute
  hour: number[]; // timestamps (ms) of recent mints in the past hour
}
const rateLimitMap = new Map<string, RateLimitWindow>();

function trimWindow(window: number[], nowMs: number, ttlMs: number): number[] {
  const cutoff = nowMs - ttlMs;
  // window is append-only and chronologically sorted; the first index
  // where timestamps[i] > cutoff is where the live window starts.
  let i = 0;
  while (i < window.length && window[i] <= cutoff) i++;
  return i === 0 ? window : window.slice(i);
}

function checkAndRecordMint(userId: string): void {
  const now = Date.now();
  let w = rateLimitMap.get(userId);
  if (w === undefined) {
    w = { minute: [], hour: [] };
    rateLimitMap.set(userId, w);
  }
  w.minute = trimWindow(w.minute, now, MINUTE_MS);
  w.hour = trimWindow(w.hour, now, HOUR_MS);
  if (w.minute.length >= TICKETS_PER_MINUTE) {
    throw new HttpException(
      `ticket-mint rate limit exceeded: ${TICKETS_PER_MINUTE}/min`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  if (w.hour.length >= TICKETS_PER_HOUR) {
    throw new HttpException(
      `ticket-mint rate limit exceeded: ${TICKETS_PER_HOUR}/hour`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  w.minute.push(now);
  w.hour.push(now);
}

@Injectable()
export class RealtimeService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Mint a StreamTicket for (actor, channel). Throws 403 if the actor
   * may not read the channel; 400 if the channel string is malformed.
   */
  async mintTicket(actor: JwtPayload, dto: MintTicketDto): Promise<MintTicketResponse> {
    // T-PERF-2 #3: rate limit FIRST (before any DB work), so a
    // misbehaving client can't burn a DB connection on every request.
    checkAndRecordMint(actor.sub);

    // 1. Parse + validate the channel.
    const parsed = parseChannel(dto.channel);
    if (parsed === null) {
      throw new BadRequestException(`unknown channel: ${dto.channel}`);
    }

    // 2. Channel access checks. For chat, the actor must be able to read
    //    the lead - same visibility the REST list uses (owner / team /
    //    admin-or-owner). This runs inside withRlsContext so the Lead
    //    row lookup honors the same policies the runtime requests do.
    if (parsed.kind === 'chat') {
      const allowed = await withRlsContext(
        this.client,
        rlsContextFrom(actor),
        async (tx) => {
          const lead = await tx.lead.findUnique({ where: { id: parsed.leadId }, select: { id: true } });
          return lead !== null;
        },
      );
      if (!allowed) {
        throw new ForbiddenException(`no access to channel ${dto.channel}`);
      }
    }

    // 3. Mint. Ticket rows are written on the bare client (auth-adjacent
    //    table, same precedent as User/Account in users.service.ts).
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
    const ticket = await this.client.streamTicket.create({
      data: {
        userId: actor.sub,
        channel: dto.channel,
        expiresAt,
        organizationId: actor.organizationId,
      },
      select: { id: true, expiresAt: true },
    });

    return {
      ticket: ticket.id,
      channel: dto.channel,
      expiresAt: ticket.expiresAt.toISOString(),
    };
  }

  /**
   * Consume a ticket: must exist, not be expired, belong to nobody in
   * particular (the cuid is the auth), and match the requested channel.
   * Single-use - deletes the row so a replayed ticket can't reconnect.
   * Returns the ticket's userId so the stream can scope its queries.
   */
  async consumeTicket(
    rawTicket: string,
    expectedChannel: string,
  ): Promise<{ userId: string; channel: string }> {
    // The SSE controller reaches this path WITHOUT a JWT (the ticket IS
    // the auth), so reads run on the bare client. The cuid is the secret.
    const ticket = await this.client.streamTicket.findUnique({
      where: { id: rawTicket },
      select: { id: true, userId: true, channel: true, expiresAt: true },
    });
    if (ticket === null) {
      throw new ForbiddenException('invalid ticket');
    }
    if (ticket.expiresAt.getTime() < Date.now()) {
      // Clean up the expired row before rejecting so the table doesn't grow.
      await this.client.streamTicket.delete({ where: { id: ticket.id } }).catch(() => undefined);
      throw new ForbiddenException('ticket expired');
    }
    if (ticket.channel !== expectedChannel) {
      throw new ForbiddenException('ticket channel mismatch');
    }
    // Single-use: delete BEFORE the stream opens. If the stream fails to
    // open, the client re-mints; a leaked ticket is worthless after this.
    await this.client.streamTicket.delete({ where: { id: ticket.id } });
    return { userId: ticket.userId, channel: ticket.channel };
  }

  /**
   * Reaping loop: delete expired tickets older than 1 hour. Called from
   * a @Cron in the module (once a minute). Cheap: indexed on expiresAt.
   */
  async reapExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const result = await this.client.streamTicket.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    return result.count;
  }
}