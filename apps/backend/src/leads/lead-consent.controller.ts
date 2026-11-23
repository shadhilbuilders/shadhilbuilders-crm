// ────────────────────────────────────────────────────────────────────────────
// Lead consent controller - record a marketing opt-in or opt-out.
// ────────────────────────────────────────────────────────────────────────────
// The write half of the MARKETING consent ledger. The read half is
// `GET /api/leads/:id`, which carries `marketingConsent` + `marketingConsentAt`
// on LeadDetail, because that is where an operator already looks.
//
// A separate controller rather than another method on LeadsController, for the
// same reason LeadFactsController is separate: one write path, its own rules,
// and LeadsController is the largest surface in the module.
//
// DTO validation happens HERE with the shared Zod schema (no Nest
// ValidationPipe - the api-types convention, see leads.controller.ts:38-55).
import { BadRequestException, Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  RecordLeadConsentDtoSchema,
  type RecordLeadConsentDto,
  type RecordLeadConsentResult,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { LeadConsentService } from './lead-consent.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
    );
  }
  return result.data;
}

@ApiTags('lead-consent')
@ApiBearerAuth()
@Controller('leads')
export class LeadConsentController {
  constructor(@Inject(LeadConsentService) private readonly consent: LeadConsentService) {}

  /**
   * Append one MARKETING consent row. The answer is what the newest row says,
   * so an opt-out after an opt-in wins without touching the opt-in row.
   */
  @Post(':id/consent')
  @ApiOperation({ summary: 'Record a marketing opt-in or opt-out for a lead' })
  record(
    @Req() req: AuthedRequest,
    @Param('id') leadId: string,
    @Body() body: unknown,
  ): Promise<RecordLeadConsentResult> {
    const dto: RecordLeadConsentDto = parseBody(RecordLeadConsentDtoSchema, body);
    // `!` after the global JwtAuthGuard, same as lead-facts.controller.ts:84 -
    // the guard rejects a request with no user before this handler runs.
    return this.consent.record(req.user!, leadId, dto);
  }
}
