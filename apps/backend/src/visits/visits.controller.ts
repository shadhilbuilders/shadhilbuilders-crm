// Visits controller - list + create + outcome + reschedule.
//
// Mirrors apps/backend/src/users/users.controller.ts and
// apps/backend/src/leads/leads.controller.ts patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit
//     design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//   - Query-string array coercion handled in the controller
//     (NestJS @Query gives string | string[] | undefined)
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateSiteVisitDtoSchema,
  RescheduleVisitDtoSchema,
  UpdateVisitOutcomeDtoSchema,
  VisitFilterDtoSchema,
  type CreateSiteVisitDto,
  type RescheduleVisitDto,
  type UpdateVisitOutcomeDto,
  type VisitFilterDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { VisitsService, type VisitListResult, type VisitRow } from './visits.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'body'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

@ApiTags('visits')
@ApiBearerAuth('jwt')
@Controller('visits')
export class VisitsController {
  constructor(
    @Inject(VisitsService) private readonly visits: VisitsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List site visits (weekly calendar). Role-scoped: TELECALLER/SALES_EXEC see own; MANAGER sees team; ADMIN/OWNER sees all.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<VisitListResult> {
    // Coerce numeric query params (Next.js BFF forwards them as strings).
    const coerced: Record<string, unknown> = { ...query };
    for (const key of ['limit', 'offset'] as const) {
      const v = coerced[key];
      if (typeof v === 'string' && v.length > 0) {
        const n = Number(v);
        if (!Number.isNaN(n)) coerced[key] = n;
      }
    }
    const dto: VisitFilterDto = parseBody(VisitFilterDtoSchema, coerced);
    return this.visits.list(req.user!, dto);
  }

  @Post()
  @ApiOperation({
    summary:
      'Schedule a new site visit. Lead must be in SCHEDULABLE_LEAD_STATES (VISIT_REQUESTED, VISIT_SCHEDULED, RESCHEDULED, NO_SHOW).',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<VisitRow> {
    const dto: CreateSiteVisitDto = parseBody(CreateSiteVisitDtoSchema, body);
    return this.visits.create(req.user!, dto);
  }

  @Patch(':id/outcome')
  @ApiOperation({
    summary:
      'Record visit outcome (COMPLETED, NO_SHOW, CANCELLED). Drives parent lead state on COMPLETED.',
  })
  async updateOutcome(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VisitRow> {
    const dto: UpdateVisitOutcomeDto = parseBody(UpdateVisitOutcomeDtoSchema, {
      ...((body as Record<string, unknown> | null) ?? {}),
      visitId: id,
    });
    return this.visits.updateOutcome(req.user!, id, dto);
  }

  @Post(':id/reschedule')
  @ApiOperation({
    summary:
      'Reschedule a SCHEDULED or NO_SHOW visit. Closes the old visit (RESCHEDULED) and creates a new one (SCHEDULED).',
  })
  async reschedule(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VisitRow> {
    const dto: RescheduleVisitDto = parseBody(RescheduleVisitDtoSchema, {
      ...((body as Record<string, unknown> | null) ?? {}),
      visitId: id,
    });
    return this.visits.reschedule(req.user!, id, dto);
  }
}
