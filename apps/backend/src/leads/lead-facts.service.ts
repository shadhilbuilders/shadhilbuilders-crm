// ────────────────────────────────────────────────────────────────────────────
// Lead facts service - the ONE write path to a lead's evidence-backed fields.
// ────────────────────────────────────────────────────────────────────────────
// T-LEAD-FACTS (2026-11-05). Design: docs/designs/lead-fact-ledger.md
//
// What this service guarantees, so no caller has to:
//   * a claim below the floor is never stored;
//   * a value a person dismissed is never offered again;
//   * a value a person typed is never overwritten;
//   * the value already in the field is never offered back to them.
// The last three are the ones a prompt, or a careful reviewer, cannot hold.
//
// Everything runs inside ONE `withRlsContext` transaction, so the org/team lane
// is enforced by Postgres as well as by the checks below - two independent
// gates on the same decision, which is the pattern every other lead-scoped
// write in this repo follows (see leads.service.ts).
//
// Prisma 7 note: never open a `$transaction` inside `withRlsContext`'s
// transaction - the pg adapter rejects a nested one. The `tx` handed in IS the
// transaction; use it directly (see leads.service.ts:createInTransaction).
// ────────────────────────────────────────────────────────────────────────────

import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, rlsContextFrom, withRlsContext, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import {
  scoreEvidence,
  type Evidence,
  type LeadFactField as FactLedgerField,
} from './lead-evidence';
import { decideLeadFactWrite, type ExistingFact, type LeadFactSubject } from './lead-facts.rules';
import { PrismaService } from '../prisma/prisma.module';
import type {
  DecideLeadFactDto,
  FactBand,
  LeadEvidence,
  LeadFactField,
  LeadFactRow,
  LeadFactsResponse,
  RecordLeadFactDto,
  RecordLeadFactResult,
} from '@shadhil/api-types';

/** The columns the ledger may read or write, in one place. */
const SUBJECT_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  email: true,
  source: true,
} as const;

@Injectable()
export class LeadFactsService {
  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {}

  /**
   * The Prisma CLIENT, not the Nest provider.
   *
   * `PrismaService` is a thin wrapper exposing `$client`, so passing the
   * service itself to `withRlsContext` made `prisma.$transaction` undefined
   * and every call here threw
   *
   *     TypeError: prisma.$transaction is not a function   -> 500
   *
   * The `as unknown as PrismaClient` cast is what hid it: it asserts the
   * shape instead of checking it, so TypeScript could not see that the two
   * types have nothing in common. Fixed 2026-11-19 (found by the e2e run -
   * the lead detail page's facts sheet had been failing to load). Same
   * accessor as organizations.service.ts, which is the established pattern.
   */
  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * The lead's current values plus its live facts (APPLIED and PROPOSED).
   * Dismissed and superseded rows are history and stay out of the sheet.
   */
  async list(actor: JwtPayload, leadId: string): Promise<LeadFactsResponse> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: leadId },
        select: SUBJECT_SELECT,
      });

      // The RLS policy already hides other orgs and other teams, so a lead
      // the actor may not see reads as absent - the correct 404 rather than
      // a 403 that confirms it exists.
      if (!lead) throw new NotFoundException('Lead not found');

      const rows = await tx.leadFact.findMany({
        where: { leadId, status: { in: ['APPLIED', 'PROPOSED'] } },
        orderBy: { observedAt: 'desc' },
      });

      return {
        leadId,
        values: { name: lead.name, email: lead.email, source: lead.source },
        facts: rows.map(toWireRow),
      };
    });
  }

  /**
   * Record an observation. `stored: false` with a `reason` is a NORMAL outcome,
   * not a failure: it is the ledger declining to put a guess on the record, and
   * the reason is written for the person reading it.
   */
  async record(
    actor: JwtPayload,
    leadId: string,
    dto: RecordLeadFactDto,
  ): Promise<RecordLeadFactResult> {
    return withRlsContext(this.client, rlsContextFrom(actor), (tx) =>
      this.recordInTransaction(actor, leadId, dto, tx as unknown as PrismaClient),
    );
  }

  /**
   * The same write, inside a caller-owned transaction. A producer that must
   * commit the observation and the row it describes together uses this (the
   * landing-form enquiry creates the Lead and its email fact in one
   * transaction, so a lead is never left without the address that created it).
   * The caller has already set the RLS context; this must not open another.
   */
  async recordInTransaction(
    actor: JwtPayload,
    leadId: string,
    dto: RecordLeadFactDto,
    client: PrismaClient,
  ): Promise<RecordLeadFactResult> {
    const evidence = dto.evidence as unknown as Evidence[];
    const scored = scoreEvidence(evidence);

    const lead = await client.lead.findUnique({
      where: { id: leadId },
      select: SUBJECT_SELECT,
    });

    if (!lead) throw new NotFoundException('Lead not found');

    const subject: LeadFactSubject = {
      name: lead.name,
      email: lead.email,
      source: lead.source,
    };

    const existingRows = await client.leadFact.findMany({
      where: { leadId, field: dto.field },
      select: { value: true, status: true },
    });

    const existing: ExistingFact[] = existingRows.map((row) => ({
      value: row.value,
      status: row.status,
    }));

    const decision = decideLeadFactWrite({
      field: dto.field as FactLedgerField,
      value: dto.value,
      scored,
      subject,
      existing,
    });

    if (decision.action === 'REFUSE' || decision.action === 'NOOP') {
      return {
        stored: false,
        applied: false,
        band: scored.band,
        score: scored.score,
        rationale: scored.rationale,
        reason: decision.reason,
      };
    }

    const applies = decision.action === 'APPLY';
    const value = dto.value.trim();

    if (applies) {
      // One APPLIED row per field: whatever it replaces becomes history.
      await client.leadFact.updateMany({
        where: {
          leadId,
          field: dto.field,
          status: { in: ['APPLIED', 'PROPOSED'] },
        },
        data: { status: 'SUPERSEDED', supersededAt: new Date() },
      });
    }

    const fact = await client.leadFact.create({
      data: {
        leadId,
        organizationId: lead.organizationId,
        field: dto.field,
        value,
        score: scored.score,
        band: scored.band as FactBand,
        evidence: dto.evidence as unknown as Prisma.InputJsonValue,
        method: dto.method,
        sourceUrl: dto.sourceUrl ?? null,
        status: applies ? 'APPLIED' : 'PROPOSED',
      },
    });

    if (!applies) {
      return {
        stored: true,
        applied: false,
        band: scored.band,
        score: scored.score,
        rationale: scored.rationale,
        reason:
          'The record is not blank here, so this is kept as a suggestion for a rep. That is a normal outcome - do not try to raise the score.',
        fact: toWireRow(fact),
      };
    }

    await client.lead.update({
      where: { id: leadId },
      data: columnPatch(dto.field, value),
    });

    await client.auditLog.create({
      data: {
        userId: actor.sub,
        organizationId: lead.organizationId,
        action: 'lead.fact.apply',
        entityType: 'Lead',
        entityId: leadId,
        before: { [dto.field]: subject[dto.field] },
        after: { [dto.field]: value },
        reason: `${dto.method} (${scored.band})`,
      },
    });

    return {
      stored: true,
      applied: true,
      band: scored.band,
      score: scored.score,
      rationale: scored.rationale,
      fact: toWireRow(fact),
    };
  }

  /**
   * A human settles a suggestion. Accepting writes the Lead column: the click
   * IS the human decision the rules were waiting for, even though every
   * automated path is forbidden from overwriting a value a person typed.
   */
  async decide(
    actor: JwtPayload,
    leadId: string,
    factId: string,
    dto: DecideLeadFactDto,
  ): Promise<LeadFactRow> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const fact = await tx.leadFact.findUnique({
        where: { id: factId },
        select: {
          id: true,
          leadId: true,
          organizationId: true,
          field: true,
          value: true,
          status: true,
        },
      });

      if (!fact || fact.leadId !== leadId) {
        throw new NotFoundException('Suggestion not found');
      }

      if (fact.status !== 'PROPOSED') {
        throw new BadRequestException(`This suggestion has already been settled (${fact.status}).`);
      }

      if (dto.decision === 'ACCEPT') {
        await tx.leadFact.updateMany({
          where: {
            leadId,
            field: fact.field,
            status: { in: ['APPLIED', 'PROPOSED'] },
            NOT: { id: fact.id },
          },
          data: { status: 'SUPERSEDED', supersededAt: new Date() },
        });

        const accepted = await tx.leadFact.update({
          where: { id: fact.id },
          data: {
            status: 'APPLIED',
            decidedById: actor.sub,
            decidedAt: new Date(),
          },
        });

        const lead = await tx.lead.findUniqueOrThrow({
          where: { id: leadId },
          select: SUBJECT_SELECT,
        });

        await tx.lead.update({
          where: { id: leadId },
          data: columnPatch(fact.field as LeadFactField, fact.value),
        });

        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            organizationId: fact.organizationId,
            action: 'lead.fact.accept',
            entityType: 'Lead',
            entityId: leadId,
            before: { [fact.field]: lead[fact.field as LeadFactField] },
            after: { [fact.field]: fact.value },
            reason: dto.reason ?? null,
          },
        });

        return toWireRow(accepted);
      }

      const dismissed = await tx.leadFact.update({
        where: { id: fact.id },
        data: {
          status: 'DISMISSED',
          decidedById: actor.sub,
          decidedAt: new Date(),
        },
      });

      await tx.auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: fact.organizationId,
          action: 'lead.fact.dismiss',
          entityType: 'Lead',
          entityId: leadId,
          before: { [fact.field]: fact.value },
          after: { [fact.field]: 'kept' },
          reason: dto.reason ?? null,
        },
      });

      return toWireRow(dismissed);
    });
  }
}

/**
 * The column write for a field, spelled out rather than computed. A computed
 * key would typecheck as a bag of strings and silently write the wrong column
 * if the field list ever grew a field whose name is not its column.
 */
function columnPatch(field: LeadFactField, value: string): Prisma.LeadUpdateInput {
  switch (field) {
    case 'name':
      return { name: value };
    case 'email':
      return { email: value };
    case 'source':
      return { source: value };
  }
}

/**
 * Prisma row -> wire row. `rationale` is recomputed from the stored evidence so
 * the UI never has to know the weights, and a weights change re-reads old rows
 * correctly instead of leaving a stale sentence on screen.
 */
function toWireRow(row: {
  id: string;
  leadId: string;
  field: string;
  value: string;
  score: number;
  band: string;
  status: string;
  evidence: Prisma.JsonValue;
  method: string;
  sourceUrl: string | null;
  observedAt: Date;
  decidedById: string | null;
  decidedAt: Date | null;
}): LeadFactRow {
  const evidence = asEvidence(row.evidence);

  return {
    id: row.id,
    leadId: row.leadId,
    field: row.field as LeadFactField,
    value: row.value,
    score: row.score,
    band: row.band as FactBand,
    status: row.status as LeadFactRow['status'],
    rationale: scoreEvidence(evidence).rationale,
    evidence,
    method: row.method,
    sourceUrl: row.sourceUrl,
    observedAt: row.observedAt.toISOString(),
    decidedById: row.decidedById,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
  };
}

/**
 * Stored JSON is only ever written by `record`, but a row can outlive a schema
 * change - drop anything that is not a recognisable entry rather than throwing
 * on a list surface.
 */
function asEvidence(value: Prisma.JsonValue): LeadEvidence[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const kind = (entry as { kind?: unknown }).kind;
    const detail = (entry as { detail?: unknown }).detail;
    const sourceUrl = (entry as { sourceUrl?: unknown }).sourceUrl;

    if (typeof kind !== 'string' || typeof detail !== 'string') return [];

    return [
      {
        kind: kind as LeadEvidence['kind'],
        detail,
        ...(typeof sourceUrl === 'string' ? { sourceUrl } : {}),
      },
    ];
  });
}
