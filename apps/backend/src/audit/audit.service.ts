// Audit service - REST surface for the audit log (READ ONLY).
//
// T-AUDIT (2026-09-07): replaces the Phase-1 stub. Audit rows are
// written by every other module as a side effect of their mutations
// (per eng-review A2: audit writes MUST be transactional with the
// triggering action). This module ONLY READS - no creation endpoint.
//
// RLS: the auditlog_select_admin_or_owner policy gates visibility:
// ADMIN sees all, others see only their own (userId = app.user_id).
// No role-scoping needed beyond the actor's JWT identity - the
// RLS policy is the source of truth.
//
// Filter DTO: AuditLogQueryDtoSchema supports userId / entityType /
// entityId / action / from / to / limit / offset. We pass the
// supplied filters through to the where clause as-is; the RLS
// policy applies the visibility filter on top.
import {
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  withRlsContext,
  rlsContextFrom,
  type PrismaClient,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { AuditLogQueryDto } from '@shadhil/api-types';

import { PrismaService } from '../prisma/prisma.module';

/**
 * Wire shape returned by the list endpoint. Matches the audit-row
 * contract consumed by apps/web/src/hooks/queries/crm.ts (useAuditLog).
 */
export interface AuditRow {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  createdAt: string;
  /** T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI6): groups every row
   * written inside one multi-row transaction (e.g. N lead-ownership
   * transfers + 1 membership removal) so the Audit page can render/
   * collapse them as one operation. Null for every action that isn't
   * part of a batch. */
  batchId: string | null;
}

export interface AuditListResult {
  total: number;
  rows: AuditRow[];
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/audit?entityType=&entityId=&userId=&from=&to=&action=
   * - filterable audit log. The auditlog_select_admin_or_owner RLS
   * policy applies visibility on top.
   */
  async list(
    actor: JwtPayload,
    dto: AuditLogQueryDto,
  ): Promise<AuditListResult> {
    return withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        const where: Record<string, unknown> = {};
        if (dto.userId !== undefined) where['userId'] = dto.userId;
        if (dto.entityType !== undefined) where['entityType'] = dto.entityType;
        if (dto.entityId !== undefined) where['entityId'] = dto.entityId;
        if (dto.action !== undefined) {
          // Multi-select actions arrive as an array (WHERE action IN (...));
          // a single action stays an exact match.
          where['action'] = Array.isArray(dto.action)
            ? { in: dto.action }
            : dto.action;
        }
        if (dto.from !== undefined || dto.to !== undefined) {
          where['createdAt'] = {
            ...(dto.from !== undefined ? { gte: new Date(dto.from) } : {}),
            ...(dto.to !== undefined ? { lte: new Date(dto.to) } : {}),
          };
        }

        const [rows, total] = await Promise.all([
          (tx as unknown as PrismaClient).auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: dto.limit,
            skip: dto.offset,
            select: {
              id: true,
              userId: true,
              action: true,
              entityType: true,
              entityId: true,
              before: true,
              after: true,
              reason: true,
              createdAt: true,
              batchId: true,
              user: { select: { name: true } },
            },
          }),
          (tx as unknown as PrismaClient).auditLog.count({ where }),
        ]);

        return {
          total,
          rows: rows.map((r) => ({
            id: r.id,
            userId: r.userId,
            userName: r.user?.name ?? null,
            action: r.action,
            entityType: r.entityType,
            entityId: r.entityId,
            // Prisma JSON columns return as objects; cast to unknown
            // for the wire shape. Callers can JSON.parse if needed.
            before: r.before as unknown,
            after: r.after as unknown,
            reason: r.reason,
            createdAt: r.createdAt.toISOString(),
            batchId: r.batchId,
          })),
        };
      },
    );
  }
}
