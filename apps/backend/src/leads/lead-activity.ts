// Lead timeline writer. Every lead-affecting action calls this INSIDE its own
// transaction, right after the AuditLog write, so the timeline and the audit
// trail cannot diverge.
//
// Deliberately NO try/catch: if the RLS insert check rejects the row the whole
// transaction rolls back (decision 1A - hard fail, never a silently empty
// timeline). The RLS matrix test pins every role x action combination.

import { BadRequestException } from '@nestjs/common';
import type { ActivityType, PrismaClient } from '@shadhil/database';

import type { JwtPayload } from '@shadhil/auth';

export interface LeadActivityInput {
  readonly leadId: string;
  readonly type: ActivityType;
  readonly body: string;
}

/** Minimal client surface so both a tx client and a mock can be passed. */
type ActivityWriter = Pick<PrismaClient, 'activity'>;

export async function recordLeadActivity(
  tx: ActivityWriter,
  actor: Pick<JwtPayload, 'sub' | 'organizationId'>,
  input: LeadActivityInput,
): Promise<void> {
  await tx.activity.create({
    data: {
      leadId: input.leadId,
      organizationId: actor.organizationId,
      userId: actor.sub,
      type: input.type,
      body: input.body,
    },
  });
}

/**
 * T-WA-VISIT-REPLY (2026-11-28): a timeline row for something the SYSTEM did on
 * the customer's behalf - today, a WhatsApp reply confirming or moving a visit.
 *
 * `userId` is null on purpose: no staff member performed it, and naming the
 * visit's assignee would put a false actor on the page a telecaller reads to
 * find out who did what. The timeline's renderer already omits the "by <name>"
 * line when there is no name to show, so the row reads as the fact it is.
 *
 * Must run inside the caller's transaction (same rule as `recordLeadActivity`),
 * and only from a CRON_SERVICE context, which `activity_insert_cron_service`
 * admits.
 */
export async function recordSystemActivity(
  tx: ActivityWriter,
  input: { organizationId: string; leadId: string; type: ActivityType; body: string },
): Promise<void> {
  await tx.activity.create({
    data: {
      leadId: input.leadId,
      organizationId: input.organizationId,
      userId: null,
      type: input.type,
      body: input.body,
    },
  });
}

/** Joins the optional detail parts of a timeline sentence, skipping blanks. */
export function withDetail(
  sentence: string,
  ...details: ReadonlyArray<string | null | undefined>
): string {
  const parts = details
    .map((d) => d?.trim())
    .filter((d): d is string => d !== undefined && d.length > 0);
  return parts.length === 0 ? sentence : `${sentence} - ${parts.join(' - ')}`;
}

const VISIT_WHEN_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

/** "12 Oct, 4:00 pm" (IST) - how visit times read on the timeline. */
export function formatVisitWhen(when: Date): string {
  return VISIT_WHEN_FORMAT.format(when).replace(/\b(am|pm)\b/i, (m) => m.toLowerCase());
}

/** Opaque keyset cursor for the timeline: position of the OLDEST row served. */
export function encodeActivityCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeActivityCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  if (rest.length > 0 || id === undefined || id.length === 0 || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('Invalid timeline cursor');
  }
  return { createdAt, id };
}
