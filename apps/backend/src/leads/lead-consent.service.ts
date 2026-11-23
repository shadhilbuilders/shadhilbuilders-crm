// Marketing consent for a lead - the only writer of the Consent ledger.
//
// WHY THIS EXISTS: the site-update WhatsApp templates were approved as
// MARKETING on 2026-11-23. site-update-consent.ts gates every outside-window
// send on the newest MARKETING row, and until this service existed nothing in
// the codebase ever wrote one - so every send recorded SKIPPED_NO_CONSENT and
// the template path had never fired. A gate with no writer is not a gate.
//
// THREE RULES, and each one is a decision rather than a convenience:
//
//   1. APPEND, NEVER UPDATE. Consent is a ledger: a later opt-out has to beat
//      an earlier opt-in, and it can only do that if both rows survive. So the
//      newest row (`grantedAt`, then `createdAt`) is the answer, which is the
//      same ordering site-update-consent.ts reads.
//   2. NO CHANGE, NO ROW. Re-recording the answer already on top would add a
//      row that means nothing and push an earlier genuine moment out of the
//      "when did they agree" answer. Idempotent on purpose: reps double-click.
//   3. THE ROW AND ITS AUDIT LIVE IN ONE TRANSACTION. A consent row with no
//      audit entry is a compliance answer nobody can reconstruct, and an audit
//      entry with no row claims something the send decision cannot see.
//
// WHO MAY WRITE: whoever RLS lets near the lead - its owner or co-owner, their
// manager, and ADMIN (OWNER is downcast to ADMIN by withRlsContext). The
// policies already exist (policies.sql, consent_insert_owner/_admin); this
// service adds no authority of its own. A lead the actor cannot see is a 404,
// not a 403, because RLS-silent-zero and a missing row are indistinguishable.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import type {
  LeadConsentAnswer,
  RecordLeadConsentDto,
  RecordLeadConsentResult,
} from '@shadhil/api-types';
import { rlsContextFrom, withRlsContext, type PrismaClient } from '@shadhil/database';

import {
  marketingConsent,
  newestMarketingConsentRow,
} from '../customer-progress/site-update-consent';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class LeadConsentService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * Record one MARKETING opt-in or opt-out for this lead.
   *
   * Returns the state AFTER the call plus the timestamp of the row that now
   * decides, so the caller can render "Opted in on 23 Nov 2026" without a
   * second round trip.
   */
  async record(
    actor: JwtPayload,
    leadId: string,
    dto: RecordLeadConsentDto,
  ): Promise<RecordLeadConsentResult> {
    const target: LeadConsentAnswer = dto.granted ? 'granted' : 'denied';
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: leadId },
        select: { id: true, organizationId: true },
      });
      if (lead === null) {
        throw new NotFoundException(`Lead ${leadId} not found`);
      }

      const current = await marketingConsent(tx, leadId);
      if (current === target) {
        // Rule 2. The answer is already the newest row; report it and write
        // nothing, including no audit row - "recorded again" is not an event.
        const latest = await newestMarketingConsentRow(tx, leadId);
        return {
          changed: false,
          answer: current,
          recordedAt: latest?.grantedAt.toISOString() ?? null,
        };
      }

      const now = new Date();
      await tx.consent.create({
        data: {
          leadId,
          organizationId: lead.organizationId,
          consentType: 'MARKETING',
          granted: dto.granted,
          grantedAt: now,
          // How it was obtained, not who typed it: `source` is the provenance
          // of the customer's agreement. The actor is on the audit row.
          source: dto.source,
          // Staff-recorded consent has no browser request behind it worth
          // citing, and a made-up IP would be worse than none.
          ipAddress: null,
        },
      });

      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: lead.organizationId,
          action: 'lead.consent.record',
          entityType: 'Lead',
          entityId: leadId,
          before: { marketingConsent: current },
          after: { marketingConsent: target, source: dto.source },
          // Empty string after trimming means "no note", not a blank reason.
          reason: dto.note !== undefined && dto.note.length > 0 ? dto.note : null,
        },
      });

      return { changed: true, answer: target, recordedAt: now.toISOString() };
    });
  }
}
