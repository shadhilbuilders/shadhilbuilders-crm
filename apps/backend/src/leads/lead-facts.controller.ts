// ────────────────────────────────────────────────────────────────────────────
// Lead facts controller - read the ledger, record an observation, settle a
// suggestion.
// ────────────────────────────────────────────────────────────────────────────
// T-LEAD-FACTS (2026-11-05).
//
// DTO validation happens HERE with the shared Zod schemas, matching
// leads.controller.ts (no Nest ValidationPipe - the api-types convention).
//
// A separate controller rather than more methods on LeadsController: the fact
// ledger has its own write path and its own rules, and `LeadsController` is
// already the largest surface in the module.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  DecideLeadFactDtoSchema,
  RecordLeadFactDtoSchema,
  type DecideLeadFactDto,
  type LeadFactsResponse,
  type LeadFactRow,
  type RecordLeadFactDto,
  type RecordLeadFactResult,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { LeadFactsService } from './lead-facts.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
    );
  }
  return result.data;
}

@ApiTags('lead-facts')
@ApiBearerAuth()
@Controller('leads')
export class LeadFactsController {
  constructor(@Inject(LeadFactsService) private readonly facts: LeadFactsService) {}

  /**
   * The lead's current values plus every live fact: APPLIED rows (already on
   * the record) and PROPOSED rows (waiting on the rep).
   */
  @Get(':leadId/facts')
  @ApiOperation({
    summary: 'List a lead’s facts and pending suggestions',
  })
  async list(
    @Req() req: AuthedRequest,
    @Param('leadId') leadId: string,
  ): Promise<LeadFactsResponse> {
    return this.facts.list(req.user!, leadId);
  }

  /**
   * Record an observation. `applied: false` with a reason is a normal answer:
   * the claim was kept as a suggestion, or refused as too weak.
   */
  @Post(':leadId/facts')
  @ApiOperation({
    summary: 'Record an evidence-backed observation about a lead',
  })
  async record(
    @Req() req: AuthedRequest,
    @Param('leadId') leadId: string,
    @Body() body: unknown,
  ): Promise<RecordLeadFactResult> {
    const dto: RecordLeadFactDto = parseBody(RecordLeadFactDtoSchema, body);
    return this.facts.record(req.user!, leadId, dto);
  }

  /** Accept or dismiss a suggestion. Accepting writes the Lead column. */
  @Patch(':leadId/facts/:factId')
  @ApiOperation({ summary: 'Accept or dismiss a pending suggestion' })
  async decide(
    @Req() req: AuthedRequest,
    @Param('leadId') leadId: string,
    @Param('factId') factId: string,
    @Body() body: unknown,
  ): Promise<LeadFactRow> {
    const dto: DecideLeadFactDto = parseBody(DecideLeadFactDtoSchema, body);
    return this.facts.decide(req.user!, leadId, factId, dto);
  }
}
