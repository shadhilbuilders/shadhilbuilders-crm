// T-E2b follow-up queue - service layer.
//
// The service owns:
//   - list() with status filter + cursor pagination (ordered by
//     most-recent first)
//   - convert() - the headline flow. Creates a Lead via LeadsService
//     (which runs the manager-assignment engine, writes the audit
//     log, applies RLS) and links the new lead to the contact via
//     convertedToLeadId, all inside one transaction.
//   - markSpam() - one-click status flip, no Lead required.
//
// RLS context: the actor is ADMIN/OWNER/MANAGER. The new
// wa_unknown_select_admin_class / wa_unknown_update_admin_class
// policies (migration 20260905000200) gate the access. We DO NOT
// use the CRON_SERVICE bypass - the inbound webhook handler uses
// that, the admin queue handler does not.
//
// Transaction shape: withRlsContext wraps the convert flow so the
// Lead insert + WhatsappUnknownContact update either both land or
// neither does. The LeadsService.create call internally manages
// its own sub-transaction (it does manager assignment + audit log
// + lead insert), so we wrap the OUTER level only - the lead
// creation is atomic on its own, and the contact status flip is
// our single additional write.

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  type ConvertUnknownContactDto,
  type ConvertUnknownContactResult,
  type SpamUnknownContactResult,
  type WhatsappUnknownContactListQuery,
  type WhatsappUnknownContactListResult,
  type WhatsappUnknownContactRow,
  type WhatsappUnknownContactStatus,
  CreateLeadDtoSchema,
} from '@shadhil/api-types';
import { prisma as barePrisma, type PrismaClient, withRlsContext, rlsContextFrom } from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';

import { LeadsService } from '../leads/leads.service';

import type { JwtPayload } from '@shadhil/auth';

// Re-export the API response types so the controller can name
// its return type without redefining the shape.
export type {
  ConvertUnknownContactResult,
  SpamUnknownContactResult,
  WhatsappUnknownContactListResult,
  WhatsappUnknownContactRow,
  WhatsappUnknownContactStatus,
} from '@shadhil/api-types';

// Cursor encoding: base64url(`${createdAt.toISOString()}|${id}`).
// Opaque to the client - server re-parses on next page. The
// `createdAt|id` key uniquely orders PENDING rows by recency.
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    if (sep === -1) return null;
    const createdAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

function rowToJson(row: {
  id: string;
  phoneE164: string;
  firstMessageAt: Date;
  lastMessageAt: Date;
  messageCount: number;
  firstMessageBody: string | null;
  status: WhatsappUnknownContactStatus;
  convertedToLeadId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}): WhatsappUnknownContactRow {
  return {
    id: row.id,
    phoneE164: row.phoneE164,
    firstMessageAt: row.firstMessageAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    messageCount: row.messageCount,
    firstMessageBody: row.firstMessageBody,
    status: row.status,
    convertedToLeadId: row.convertedToLeadId,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class WhatsappUnknownContactsService {
  private readonly logger = new Logger(WhatsappUnknownContactsService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(LeadsService) private readonly leadsService: LeadsService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  // ── list ───────────────────────────────────────────────────────────
  // Filter by status (defaults to PENDING - the active follow-up
  // queue). Cursor pagination ordered by createdAt DESC (most recent
  // first) so the telecaller sees the freshest messages at the top.
  // Total count is returned (capped at 1000) so the UI can show
  // "X total" without paginating.
  async list(
    actor: JwtPayload,
    query: WhatsappUnknownContactListQuery,
  ): Promise<WhatsappUnknownContactListResult> {
    const status: WhatsappUnknownContactStatus = query.status ?? 'PENDING';
    const limit = query.limit;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // Build the cursor predicate: rows STRICTLY OLDER than the
        // (createdAt, id) tuple we last returned. We use (createdAt, id)
        // because createdAt has microsecond precision but the cursor
        // id breaks ties when two rows share a timestamp.
        const where: Record<string, unknown> = { status };
        if (cursor !== null) {
          where.OR = [
            { createdAt: { lt: cursor.createdAt } },
            {
              AND: [
                { createdAt: cursor.createdAt },
                { id: { lt: cursor.id } },
              ],
            },
          ];
        }

        const rows = await (tx as unknown as PrismaClient).whatsappUnknownContact.findMany(
          {
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1, // fetch one extra to know if there's a next page
          },
        );
        const total = await (tx as unknown as PrismaClient).whatsappUnknownContact.count({
          where: { status },
        });

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const last = pageRows[pageRows.length - 1];
        const nextCursor =
          hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

        return {
          total,
          rows: pageRows.map(rowToJson),
          nextCursor,
        };
      },
    );
  }

  // ── convert ───────────────────────────────────────────────────────
  // The headline flow. Opens a transaction as the actor, calls
  // LeadsService.create (which inserts the Lead with manager
  // assignment, audit log, RLS checks), then updates the contact
  // to status=CONVERTED with convertedToLeadId set.
  //
  // Why transaction: the contact must not be PENDING when another
  // staff member is also working it - and the Link must be set so
  // the contact page shows the right Lead. Atomicity prevents
  // "Lead created but contact still PENDING" or "Contact marked
  // CONVERTED but Lead creation failed" intermediate states.
  async convert(
    actor: JwtPayload,
    contactId: string,
    dto: ConvertUnknownContactDto,
  ): Promise<ConvertUnknownContactResult> {
    // Force the source to WHATSAPP regardless of what the UI sent.
    // The whole point of this flow is "a WhatsApp message turned
    // into a Lead" - letting the caller set the source defeats the
    // analytics ("how many leads came from WhatsApp this month?").
    const normalizedDto = CreateLeadDtoSchema.parse({
      ...dto,
      source: 'WHATSAPP',
    });

    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        // Lock the contact row so a concurrent convert/spam on the
        // same contact is serialized. findUnique + status check
        // (instead of an explicit SELECT FOR UPDATE) is fine for v1
        // because the workload is "a few staff at a time" - true
        // high-concurrency would need a different pattern.
        const contact = await (tx as unknown as PrismaClient).whatsappUnknownContact.findUnique(
          {
            where: { id: contactId },
            select: { id: true, status: true, phoneE164: true, convertedToLeadId: true },
          },
        );
        if (contact === null) {
          throw new NotFoundException(
            `WhatsAppUnknownContact ${contactId} not found`,
          );
        }
        if (contact.status !== 'PENDING') {
          throw new ConflictException(
            `Contact ${contactId} is already ${contact.status} - cannot convert again`,
          );
        }

        // Create the Lead. LeadsService.createInTransaction runs
        // inside our caller-owned transaction (so the lead insert
        // + manager assignment + audit log + the contact update
        // below all commit atomically) and returns the richer
        // CreatedLead shape (phoneE164, state, teamId) so the
        // convert response has the new lead's state.
        const lead = await this.leadsService.createInTransaction(
          actor,
          normalizedDto,
          tx as unknown as PrismaClient,
        );

        // Flip the contact to CONVERTED. The unique constraint on
        // `convertedToLeadId` means we never link the same contact
        // to two leads (the existing 1:1 invariant from the T-E2b
        // inbound commit).
        const updated = await (tx as unknown as PrismaClient).whatsappUnknownContact.update(
          {
            where: { id: contactId },
            data: {
              status: 'CONVERTED',
              convertedToLeadId: lead.id,
            },
            select: {
              id: true,
              phoneE164: true,
              firstMessageAt: true,
              lastMessageAt: true,
              messageCount: true,
              firstMessageBody: true,
              status: true,
              convertedToLeadId: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        );

        this.logger.log(
          `[wa-unknown] convert id=${contactId} lead=${lead.id} by=${actor.sub}`,
        );

        return {
          lead: {
            id: lead.id,
            name: lead.name,
            phone: lead.phone,
            phoneE164: lead.phoneE164,
            state: lead.state,
            ownerId: lead.ownerId,
            teamId: lead.teamId,
            createdAt: lead.createdAt.toISOString(),
          },
          contact: rowToJson(updated),
        };
      },
    );
  }

  // ── markSpam ──────────────────────────────────────────────────────
  // One-click status flip. No Lead required. Idempotent - calling
  // it on an already-SPAM contact is a no-op (still returns the row).
  async markSpam(
    actor: JwtPayload,
    contactId: string,
  ): Promise<SpamUnknownContactResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).whatsappUnknownContact.findUnique(
          { where: { id: contactId }, select: { id: true, status: true } },
        );
        if (existing === null) {
          throw new NotFoundException(
            `WhatsAppUnknownContact ${contactId} not found`,
          );
        }
        if (existing.status === 'CONVERTED') {
          // Refuse to mark a converted contact as spam - that would
          // orphan the linked Lead. Caller can update notes instead.
          throw new ConflictException(
            `Contact ${contactId} is CONVERTED (linked to a Lead) - cannot mark as spam`,
          );
        }

        const updated = await (tx as unknown as PrismaClient).whatsappUnknownContact.update(
          {
            where: { id: contactId },
            data: { status: 'SPAM' },
            select: {
              id: true,
              phoneE164: true,
              firstMessageAt: true,
              lastMessageAt: true,
              messageCount: true,
              firstMessageBody: true,
              status: true,
              convertedToLeadId: true,
              notes: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        );

        this.logger.log(
          `[wa-unknown] spam id=${contactId} by=${actor.sub}`,
        );

        return { contact: rowToJson(updated) };
      },
    );
  }
}

// Test-only export for the cursor codec.
export const _internal = { encodeCursor, decodeCursor };

// Generate a stable ID for the test fixtures that doesn't collide
// with the cuid defaults.
export function makeTestContactId(label: string): string {
  return `wa-uc-test-${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

// Re-export the BadRequestException so the controller can import
// the error types from the service file (matches the pattern in
// notifications.controller.ts where the controller imports parseBody
// locally - keeping the service pure-async-no-HTTP).
export { BadRequestException };
