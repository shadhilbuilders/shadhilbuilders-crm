// Public leads - controller.
//
// POST /api/public/leads - the landing page submits an enquiry and it
// becomes a real CRM Lead immediately.
//
// Auth: @Public() opts out of the global JwtAuthGuard (the landing page is
// a server, not a browser with a JWT); @UseGuards(ApiKeyGuard) validates the
// `x-api-key` header against PUBLIC_API_KEY (constant-time compare). Both
// anonymous public endpoints (feedback + leads) share this single key.
//
// The lead is created as a synthetic ADMIN actor (see service) so it routes
// through the existing manager-assignment engine + lead RLS policies with no
// new schema. The engine assigns the lead to the matching
// telecaller/sales-exec (source=LANDING), the team's default assignee, or a
// configured fallback owner — so the landing enquiry lands in the real leads
// inbox with a real owner, claimable and routed exactly like any other lead.
import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PublicCreateLeadDtoSchema,
  type PublicCreateLeadDto,
  type PublicCreateLeadResult,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { Public } from '../auth/public.decorator';

import { ApiKeyGuard } from '../feedbacks/api-key.guard';
import { PublicLeadsService } from './public-leads.service';

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

@ApiTags('public')
@Controller('public')
export class PublicLeadsController {
  constructor(
    @Inject(PublicLeadsService) private readonly service: PublicLeadsService,
  ) {}

  @Public()
  @UseGuards(new ApiKeyGuard('PUBLIC_API_KEY'))
  @Post('leads')
  @ApiOperation({
    summary:
      'Create a Lead from a landing-page enquiry (API-key gated, no JWT). ' +
      'Source is forced to LANDING; the lead is auto-assigned via the ' +
      'manager-assignment engine.',
  })
  async create(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ): Promise<PublicCreateLeadResult> {
    const dto: PublicCreateLeadDto = parseBody(PublicCreateLeadDtoSchema, body);
    return this.service.createLead(dto);
  }
}
