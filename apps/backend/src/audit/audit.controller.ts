// Audit controller - filterable audit log list.
//
// Mirrors apps/backend/src/leads/leads.controller.ts and
// apps/backend/src/visits/visits.controller.ts patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit
//     design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//
// Endpoint shape matches the web hook (apps/web/src/hooks/queries/crm.ts):
//   - GET /api/audit?entityType=&entityId=&userId=&action=&from=&to=
//     (useAuditLog hook)
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AuditLogQueryDtoSchema,
  type AuditLogQueryDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import {
  AuditService,
  type AuditListResult,
} from './audit.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

@ApiTags('audit')
@ApiBearerAuth('jwt')
@Controller('audit')
export class AuditController {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List audit log entries. RLS-gated: ADMIN sees all, others see own.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<AuditListResult> {
    // Coerce numeric query params (Next.js BFF forwards them as strings).
    const limit =
      typeof query['limit'] === 'string'
        ? Number.parseInt(query['limit'], 10)
        : undefined;
    const offset =
      typeof query['offset'] === 'string'
        ? Number.parseInt(query['offset'], 10)
        : undefined;
    // The frontend joins multi-select actions with a comma
    // (`action=lead.transition,booking.approve`). Split before schema
    // validation so the service can apply WHERE action IN (...).
    const actionRaw = query['action'];
    let action: string | string[] | undefined;
    if (typeof actionRaw === 'string') {
      const parts = actionRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      action = parts.length > 1 ? parts : parts[0];
      if (parts.length === 0) action = undefined;
    } else if (Array.isArray(actionRaw)) {
      action = actionRaw.filter((v): v is string => typeof v === 'string');
    }
    const dto: AuditLogQueryDto = parseBody(
      AuditLogQueryDtoSchema,
      {
        ...query,
        action,
        limit,
        offset,
      },
    );
    return this.audit.list(req.user!, dto);
  }
}
