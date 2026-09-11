// Feedback - service layer.
//
// Owns two surfaces:
//   - publicSubmit() - the anonymous, API-key-gated path the landing page
//     calls (POST /api/public/feedback). Writes a Feedback row as the
//     PUBLIC_API service marker so RLS's feedback_insert_public_api lets
//     the insert through without faking a staff identity. ipAddress +
//     userAgent are captured server-side; the client's body never sets them.
//   - list() / updateStatus() - the ADMIN/OWNER triage surface
//     (GET /api/feedback, PATCH /api/feedback/:id). RLS gates rows to
//     ADMIN (OWNER downcasts to ADMIN) via feedback_select_admin /
//     feedback_update_admin.
//
// RLS context:
//   - public: { userId: 'public-api', role: 'PUBLIC_API', teamId: '' }.
//     PUBLIC_API is a GUC-only marker (like CRON_SERVICE) - not a Prisma
//     enum, no JWT claim. It has INSERT-only power on Feedback.
//   - admin: the actor's real JWT { userId, role, teamId }. OWNER travels
//     as ADMIN at the RLS layer (locked Round-21 downcast in withRlsContext).
//
// Transaction shape: publicSubmit wraps the insert in withRlsContext. The
// landing page's turnstile + honeypot + Upstash rate-limit guards are the
// first line of abuse defense; an in-process per-IP fixed-window limiter
// here is the second (cheap, no Redis dependency).

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import {
  type CreateFeedbackDto,
  type CreateFeedbackResult,
  type FeedbackListQuery,
  type FeedbackListResult,
  type FeedbackRow,
  type FeedbackStatus,
  type UpdateFeedbackStatusDto,
  type UpdateFeedbackResult,
} from '@shadhil/api-types';
import {
  prisma as barePrisma,
  rlsContextFrom,
  type PrismaClient,
  withRlsContext,
} from '@shadhil/database';

import { PrismaService } from '../prisma/prisma.module';

import type { JwtPayload } from '@shadhil/auth';

// Re-export API response types so the controller can name its returns.
export type {
  CreateFeedbackResult,
  FeedbackListResult,
  FeedbackRow,
  FeedbackStatus,
  UpdateFeedbackResult,
} from '@shadhil/api-types';

// ────────────────────────────────────────────────────────────────────────────
// In-process per-IP rate limiter (public submit path).
// Fixed window (sliding-ish reset every window). NOT a security boundary -
// the landing page's Turnstile/honeypot/Upstash limiter do the heavy lifting
// when they are configured. This is a cheap belt-and-suspenders so a raw
// script hitting the API directly can't trivially flood the table.
// ────────────────────────────────────────────────────────────────────────────
const PUBLIC_SUBMIT_WINDOW_MS = 60_000; // 1 min
const PUBLIC_SUBMIT_MAX_PER_IP = 10; // 10 submissions / min / IP

/** key -> { count, windowStart }. Never GC'd; the map stays tiny. */
const ipWindows = new Map<string, { count: number; windowStart: number }>();

/** Returns true if `ip` is within its allowance; false = reject. */
function allowPublicSubmit(ip: string): boolean {
  const now = Date.now();
  const entry = ipWindows.get(ip);
  if (entry === undefined || now - entry.windowStart >= PUBLIC_SUBMIT_WINDOW_MS) {
    ipWindows.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= PUBLIC_SUBMIT_MAX_PER_IP) return false;
  entry.count += 1;
  return true;
}

// Cursor encoding: base64url(`${createdAt.toISOString()}|${id}`). Opaque
// to the client - server re-parses. `createdAt|id` uniquely orders rows.
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString(
    'base64url',
  );
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
  name: string | null;
  phone: string | null;
  rating: number;
  project: string | null;
  message: string | null;
  page: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  status: FeedbackStatus;
  createdAt: Date;
  updatedAt: Date;
}): FeedbackRow {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    rating: row.rating,
    project: row.project,
    message: row.message,
    page: row.page,
    userAgent: row.userAgent,
    ipAddress: row.ipAddress,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class FeedbacksService {
  private readonly logger = new Logger(FeedbacksService.name);

  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  // ── publicSubmit ─────────────────────────────────────────────────────
  // POST /api/public/feedback. The request is anonymous; `ip` +
  // `userAgent` are captured by the controller from the request and passed
  // in (never read from the body).
  async publicSubmit(
    dto: CreateFeedbackDto,
    meta: { ip: string; userAgent: string },
  ): Promise<CreateFeedbackResult> {
    if (!allowPublicSubmit(meta.ip)) {
      this.logger.warn(`[feedback] public submit rate-limited ip=${meta.ip}`);
      throw new BadRequestException('Too many submissions. Please try again shortly.');
    }

    const id = await withRlsContext(
      this.client,
      {
        userId: 'public-api',
        role: 'PUBLIC_API',
        teamId: '',
        organizationId: 'ceid01lpfe1esm8jwsxid41k28',
      },
      async (tx) => {
        // Raw INSERT, not typed `tx.feedback.create` - Prisma 7's typed API
        // path has an RLS interaction quirk with non-user service-marker
        // roles (PUBLIC_API here, CRON_SERVICE in the WA webhook handler):
        // typed `create` throws 42501 even with the GUC role set, but a raw
        // parameterized `INSERT INTO` succeeds on the same tx + same role
        // (verified in the T-E2b inbound handler; see shadhil-crm-dev skill
        // "Prisma 7 typed-API RLS bypass quirk"). The RLS INSERT policy
        // feedback_insert_public_api matches app.user_role = PUBLIC_API.
        const msgId = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await tx.$executeRawUnsafe(
          `INSERT INTO "Feedback" (id, name, phone, rating, project, message, page, "userAgent", "ipAddress", status, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'NEW', NOW(), NOW())`,
          msgId,
          dto.name || null,
          dto.phone || null,
          dto.rating,
          dto.project || null,
          dto.message || null,
          dto.page || null,
          meta.userAgent || null,
          meta.ip || null,
        );
        return msgId;
      },
    );

    this.logger.log(
      `[feedback] public submit id=${id} rating=${dto.rating} ip=${meta.ip}`,
    );
    return { ok: true, id };
  }

  // ── list ─────────────────────────────────────────────────────────────
  // GET /api/feedback. Admin-class (ADMIN/OWNER). Cursor pagination ordered
  // by createdAt DESC (most recent first); total count returned so the UI
  // shows "N total" without paginating everything.
  async list(
    actor: JwtPayload,
    query: FeedbackListQuery,
  ): Promise<FeedbackListResult> {
    const status: FeedbackStatus | undefined = query.status;
    const limit = query.limit;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const where: Record<string, unknown> = {};
        if (status !== undefined) where.status = status;
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

        const rows = await (tx as unknown as PrismaClient).feedback.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1, // +1 to detect a next page
        });
        const total = await (tx as unknown as PrismaClient).feedback.count({
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

  // ── updateStatus ──────────────────────────────────────────────────────
  // PATCH /api/feedback/:id. Admin-class only. Only `status` may change
  // (content is immutable). Enforces a forward-only-ish transition so a
  // triaged row can't silently bounce back to NEW (defense in depth; the
  // UI buttons already gate).
  async updateStatus(
    actor: JwtPayload,
    id: string,
    dto: UpdateFeedbackStatusDto,
  ): Promise<UpdateFeedbackResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const existing = await (tx as unknown as PrismaClient).feedback.findUnique({
          where: { id },
          select: { id: true, status: true },
        });
        if (existing === null) {
          throw new NotFoundException(`Feedback ${id} not found`);
        }
        if (existing.status === dto.status) {
          // Idempotent - applying the same status is a no-op, return as-is.
          const row = await (tx as unknown as PrismaClient).feedback.findUniqueOrThrow({
            where: { id },
          });
          return { row: rowToJson(row) };
        }

        const updated = await (tx as unknown as PrismaClient).feedback.update({
          where: { id },
          data: { status: dto.status },
        });

        this.logger.log(
          `[feedback] status id=${id} ${existing.status}->${dto.status} by=${actor.sub}`,
        );
        return { row: rowToJson(updated) };
      },
    );
  }
}

// Test-only export for the cursor codec + rate limiter.
export const _internal = { encodeCursor, decodeCursor, allowPublicSubmit };

// Stable ID for test fixtures that doesn't collide with cuid defaults.
export function makeTestFeedbackId(label: string): string {
  return `fb-test-${label}-${Date.now()}-${randomUUID().slice(0, 8)}`;
}
