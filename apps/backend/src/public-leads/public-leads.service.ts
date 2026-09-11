// Public leads - service layer.
//
// POST /api/public/leads maps a landing-page EnquiryInput to a real CRM
// Lead and creates it via LeadsService.create():
//
//   - source is FORCED to "LANDING" (never trusted from the client), so the
//     manager-assignment engine routes it by the source=LANDING rule.
//   - The lead runs as a synthetic ADMIN actor (sub = the configured
//     fallback owner). This reuses the existing ADMIN lead-create path
//     (lead_insert_admin / lead_select_admin / the engine's ADMIN rule read)
//     - NO new RLS policies are needed, and ADMIN is not a real JWT we mint;
//     it is only used to satisfy the RLS context for this one create call.
//   - Ownership: the engine assigns to the matching telecaller/sales-exec,
//     else the team's default assignee, else LEADS_FALLBACK_OWNER_ID
//     (the config'd destination owner — used as actor.sub so the engine's
//     fallback targets a REAL user, not a service-account pseudo-id).
//
// The landing page keeps Google Sheets as its primary record (delivery
// status tracking); the CRM Lead is an ADDITIONAL write, best-effort and
// non-throwing on the landing side (mirror pattern, like the Supabase
// mirror). This endpoint is that write.

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { CreateLeadDtoSchema } from '@shadhil/api-types';

import { LeadsService } from '../leads/leads.service';

import type {
  PublicCreateLeadDto,
  PublicCreateLeadResult,
} from '@shadhil/api-types';

@Injectable()
export class PublicLeadsService {
  private readonly logger = new Logger(PublicLeadsService.name);

  constructor(@Inject(LeadsService) private readonly leadsService: LeadsService) {}

  /**
   * Create a Lead from a landing enquiry. Returns the new lead id + state.
   */
  async createLead(dto: PublicCreateLeadDto): Promise<PublicCreateLeadResult> {
    // Resolve the configured fallback owner. When no rule/default-assignee
    // matches, the engine assigns the lead here (instead of a pseudo-id).
    const fallbackOwnerId =
      process.env['LEADS_FALLBACK_OWNER_ID'] ?? '';
    if (fallbackOwnerId === '') {
      throw new BadRequestException(
        'LEADS_FALLBACK_OWNER_ID is not configured - cannot create a landing lead without a destination owner',
      );
    }

    // Compose notes from the enquiry's requirement + message (Lead has no
    // separate columns for them). Keep it compact and useful to a telecaller.
    const notes = [dto.requirement, dto.message]
      .map((s) => (s && s.trim() ? s.trim() : null))
      .filter(Boolean)
      .join('\n');

    const createDto = CreateLeadDtoSchema.parse({
      name: dto.fullName,
      phone: dto.phone,
      email: dto.email || undefined,
      source: 'LANDING', // forced - analytics + routing must be correct
      notes: notes || undefined,
    });

    // Synthetic ADMIN actor. teamId:null makes _createWithClient resolve the
    // DEFAULT (oldest) team, as it does for a real teamless admin — the
    // engine then routes within that team. sub = fallback owner so the
    // engine's no-match fallback assigns a REAL user.
    const actor: JwtPayload = {
      sub: fallbackOwnerId,
      role: 'ADMIN',
      teamId: null,
      email: 'landing@shadhilbuilders.in',
      // iat/exp/iss are unused by create(); fill with inert values so the
      // payload satisfies the JwtPayload shape.
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: 'shadhil-crm',
    };

    const lead = await this.leadsService.create(actor, createDto);

    this.logger.log(
      `[public-leads] created lead=${lead.id} owner=${lead.ownerId} source=LANDING`,
    );
    return { ok: true, id: lead.id, state: lead.status };
  }
}
