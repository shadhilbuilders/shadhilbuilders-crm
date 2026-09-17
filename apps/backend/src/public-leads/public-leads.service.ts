// Public leads - service layer.
//
// POST /api/public/leads maps a landing-page EnquiryInput to a real CRM
// Lead and creates it via LeadsService.create():
//
//   - source is FORCED to "LANDING" (never trusted from the client), so the
//     manager-assignment engine routes it by the source=LANDING rule.
//   - The lead runs as a synthetic ADMIN actor (sub = the resolved owner).
//     This reuses the existing ADMIN lead-create path without new RLS
//     policies; ADMIN is not a real JWT we mint, it is only used to satisfy
//     the RLS context for this one create call.
//   - Ownership (2026-09-12): the landing page may send an `ownerId` to
//     override engine assignment. When present AND valid (a real staff user
//     in the resolved org/team) it becomes the lead's owner; when absent or
//     invalid it falls through to the manager-assignment engine (rule ->
//     team default -> LEADS_FALLBACK_OWNER_ID). This keeps a caller-supplied
//     owner from dumping leads onto arbitrary/spammy staff.
//   - Org + project targeting (2026-09-12): the landing page sends SLUGS
//     (`orgSlug`, `projectSlug`); the service resolves them -> cuid ids
//     server-side. Omitted slugs fall back to PUBLIC_ORG_ID and
//     LEADS_FALLBACK_PROJECT_ID env vars.
//
// The landing page keeps Google Sheets as its primary record (delivery
// status tracking); the CRM Lead is an ADDITIONAL write, best-effort and
// non-throwing on the landing side (mirror pattern). This endpoint is that
// write.

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { withRlsContext, type PrismaClient } from '@shadhil/database';
import {
  CreateLeadDtoSchema,
} from '@shadhil/api-types';

import { LeadsService } from '../leads/leads.service';
import { PrismaService } from '../prisma/prisma.module';

import type {
  PublicCreateLeadDto,
  PublicCreateLeadResult,
} from '@shadhil/api-types';

// Service-account RLS context for the public-leads slug lookups. All of
// Organization / Project (and Lead) are FORCE ROW LEVEL SECURITY; reading
// them through the BARE client with no app.user_org_id set returns zero
// rows (NULL org => fail-closed). We use the CRON_SERVICE + 'cron-service'
// sentinel the webhook/cron paths already use: it's an org-scoped bypass
// (org must still equal app.user_org_id), and matches the documented
// service-account impersonation guard.
const SERVICE_CTX = {
  userId: 'cron-service',
  role: 'CRON_SERVICE' as const,
  organizationId: '',
};

@Injectable()
export class PublicLeadsService {
  private readonly logger = new Logger(PublicLeadsService.name);

  constructor(
    @Inject(LeadsService) private readonly leadsService: LeadsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** Read-only RLS context for resolving org/project slugs. */
  private get client(): PrismaClient {
    return this.prisma.$client;
  }

  /**
   * Create a Lead from a landing enquiry. Returns the new lead id + state.
   */
  async createLead(dto: PublicCreateLeadDto): Promise<PublicCreateLeadResult> {
    // Resolve the org: prefer the landing-supplied slug, else PUBLIC_ORG_ID.
    const orgId = await this.resolveOrgId(dto.orgSlug);
    // Resolve the project: prefer the landing-supplied slug, else the
    // configured fallback project. projectId is optional on Lead (nullable).
    const projectId = await this.resolveProjectId(dto.projectSlug, orgId);

    // Validate an optional caller-supplied owner against the resolved org.
    // When valid it overrides the engine; when invalid we ignore it and let
    // the engine assign (never trust an arbitrary staff id blind).
    const forcedOwnerId = await this.validateOwner(
      dto.ownerId ?? '',
      orgId,
    );
    if (forcedOwnerId !== null) {
      this.logger.log(
        `[public-leads] ownerOverride org=${orgId} owner=${forcedOwnerId}`,
      );
    }

    // Resolve the configured fallback owner (engine's no-match fallback).
    const fallbackOwnerId =
      process.env['LEADS_FALLBACK_OWNER_ID'] ?? '';
    if (fallbackOwnerId === '') {
      throw new BadRequestException(
        'LEADS_FALLBACK_OWNER_ID is not configured - cannot create a landing lead without a destination owner',
      );
    }

    const notes = [dto.requirement, dto.message]
      .map((s) => (s && s.trim() ? s.trim() : null))
      .filter(Boolean)
      .join('\n');

    const createDto = CreateLeadDtoSchema.parse({
      name: dto.fullName,
      phone: dto.phone,
      email: dto.email || undefined,
      source: 'LANDING', // forced - analytics + routing must be correct
      projectId: projectId ?? undefined,
      notes: notes || undefined,
      // Validated owner override threaded into the DTO. The lead service
      // bypasses the engine only when this is present (internal field).
      assignedOwnerId: forcedOwnerId ?? undefined,
    });

    // Synthetic ADMIN actor. teamId:null makes _createWithClient resolve the
    // DEFAULT (oldest) team, as it does for a real teamless admin. sub is
    // set to the forced owner (when present) so RLS + audit attribute the
    // create correctly; otherwise fall back to the configured destination
    // owner.
    const actor: JwtPayload = {
      sub: forcedOwnerId ?? fallbackOwnerId,
      role: 'ADMIN',
      organizationId: orgId,
      email: 'landing@shadhilbuilders.in',
      // iat/exp/iss are unused by create(); fill with inert values so the
      // payload satisfies the JwtPayload shape.
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: 'shadhil-crm',
    };

    const lead = await this.leadsService.create(actor, createDto);

    this.logger.log(
      `[public-leads] created lead=${lead.id} owner=${lead.ownerId} source=LANDING org=${orgId} project=${projectId ?? 'null'}`,
    );
    return { ok: true, id: lead.id, state: lead.status };
  }

  /** Resolve an org slug -> org id. Falls back to PUBLIC_ORG_ID env when the
   *  landing sends no slug. Organization is FORCE RLS and org-select policies
   *  require id == app.user_org_id, so the lookup runs with the context
   *  scoped to the configured PUBLIC_ORG_ID (the single org in this deploy)
   *  and confirms the slug maps to that org. Throws if neither is available
   *  or the slug doesn't resolve to the configured org. */
  private async resolveOrgId(slug: string | undefined): Promise<string> {
    const fallback = process.env['PUBLIC_ORG_ID'] ?? '';
    if (fallback === '') {
      throw new BadRequestException(
        'PUBLIC_ORG_ID is not configured - provide orgSlug or set the fallback',
      );
    }
    if (slug && slug.trim().length > 0) {
      const resolved = await withRlsContext(
        this.client,
        { ...SERVICE_CTX, organizationId: fallback },
        (tx) =>
          (tx as unknown as PrismaClient).organization.findUnique({
            where: { slug: slug.trim() },
            select: { id: true },
          }),
      );
      if (resolved === null || resolved.id !== fallback) {
        throw new BadRequestException(
          `orgSlug "${slug}" does not resolve to the configured organization`,
        );
      }
      return fallback;
    }
    return fallback;
  }

  /** Resolve a project slug -> project id (scoped to the org).
   *
   *  T-LEAD-PROJECT-REQUIRED (2026-09-16): a Lead MUST have a project, so this
   *  never returns null for a successful resolution. It previously returned null
   *  when neither a slug nor the env fallback was configured, which silently
   *  created a project-less lead - the exact corruption this change removes.
   *  Misconfiguration now fails loudly (see the throws below) instead of
   *  producing data that no project surface can ever show. */
  private async resolveProjectId(
    slug: string | undefined,
    orgId: string,
  ): Promise<string> {
    const fallback = process.env['LEADS_FALLBACK_PROJECT_ID'] ?? '';
    if (slug && slug.trim().length > 0) {
      const project = await withRlsContext(
        this.client,
        { ...SERVICE_CTX, organizationId: orgId },
        (tx) =>
          (tx as unknown as PrismaClient).project.findFirst({
            where: { slug: slug.trim(), organizationId: orgId },
            select: { id: true },
          }),
      );
      if (project === null) {
        throw new BadRequestException(
          `projectSlug "${slug}" does not resolve to a project in this organization`,
        );
      }
      return project.id;
    }
    if (fallback === '') {
      // T-LEAD-PROJECT-REQUIRED: fail loudly. Returning null here is how a
      // project-less lead got created; a landing enquiry that cannot be given a
      // project is a CONFIGURATION fault, and losing the enquiry is worse than
      // a 500 the operator can see and fix.
      throw new BadRequestException(
        'No project for this lead: the form sent no projectSlug and LEADS_FALLBACK_PROJECT_ID is not configured.',
      );
    }
    // Verify the fallback project actually exists + belongs to this org, so
    // a stale/misconfigured fallback doesn't silently create lead orphans.
    const project = await withRlsContext(
      this.client,
      { ...SERVICE_CTX, organizationId: orgId },
      (tx) =>
        (tx as unknown as PrismaClient).project.findFirst({
          where: { id: fallback, organizationId: orgId },
          select: { id: true },
        }),
    );
    if (project === null) {
      // Same reasoning: a stale fallback is a configuration fault, not a reason
      // to write a lead that no project surface can ever display.
      throw new BadRequestException(
        `LEADS_FALLBACK_PROJECT_ID "${fallback}" does not resolve to a project in this organization.`,
      );
    }
    return project.id;
  }

  /** Validate an optional caller-supplied owner. Returns the owner id when it
   *  is provided AND resolves to a real user in the org; null otherwise (the
   *  caller never forces an owner). Invalid ids are ignored, not rejected, so
   *  a bad/malicious ownerId can't block lead capture or dump leads onto
   *  unrelated staff. */
  private async validateOwner(
    ownerId: string,
    orgId: string,
  ): Promise<string | null> {
    const id = ownerId.trim();
    if (id === '') return null;
    const user = await this.prisma.$client.user.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    if (user === null || user.organizationId !== orgId) {
      this.logger.warn(
        `[public-leads] owner override rejected: ownerId=${id} is not a valid user in org=${orgId}`,
      );
      return null;
    }
    return user.id;
  }
}
