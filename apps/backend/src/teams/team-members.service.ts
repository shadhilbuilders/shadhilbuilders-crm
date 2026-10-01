// TeamMembersService - T-TEAM-AUTHORITATIVE (2026-09-13, Decision Audit
// Trail #39). Implements the design doc's removal/reassignment flow:
//
//   GET  /api/teams/:teamId/members/:userId/removal-preview
//   POST /api/teams/:teamId/members/:userId/reassign-and-remove
//
// Every lead the departing member owns/co-owns within THIS team is
// transferred to an eligible same-team replacement, atomically with the
// TeamMember row's removal, inside one transaction sharing one audit
// batchId (plan A2/G-1: high-stakes audit writes happen in the SAME
// transaction as the action).
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  withRlsContext,
  rlsContextFrom,
  type PrismaClient,
  type LeadState,
  type Role,
} from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';

import { LEAD_IN_ACTIVE_PROJECT } from '../common/soft-delete-filters';
import type {
  ReassignAndRemoveDto,
  ReassignAndRemoveResponse,
  RemovalPreviewResponse,
  ReplacementCandidate,
  UpdateTeamMemberCapDto,
  UpdateTeamMemberWeightDto,
} from '@shadhil/api-types';

import { canRoleOwnState } from '../leads/leads.state-machine';
import { PrismaService } from '../prisma/prisma.module';
import {
  CodedBadRequestException,
  CodedConflictException,
  CodedForbiddenException,
  CodedNotFoundException,
} from '../common/errors/coded-exception';

import { TeamAccessService } from './team-access.service';
import {
  computePreviewToken,
  planOwnershipTransfer,
  type LeadOwnershipSnapshot,
} from './team-removal.util';

type Tx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$use' | '$extends'
>;

/** Interactive-transaction cap (design doc: "loads at most 1,000 affected
 * leads"). Preview fails fast with TOO_MANY_AFFECTED_LEADS above this. */
const MAX_AFFECTED_LEADS = 1000;

/** Non-admin staff roles eligible to be a replacement candidate at all
 * (OWNER/ADMIN are structurally excluded from this picker per the design
 * doc's ownership-eligibility table). */
const CANDIDATE_ROLES: readonly Role[] = ['TELECALLER', 'SALES_EXEC', 'MANAGER'];

interface CandidateMember {
  userId: string;
  name: string;
  role: Role;
  isTeamManager: boolean;
}

@Injectable()
export class TeamMembersService {
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
    @Inject(TeamAccessService) private readonly teamAccess: TeamAccessService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * GET /api/teams/:teamId/members/:userId/removal-preview.
   *
   * Throws LAST_TEAM_PARTICIPANT / NO_ELIGIBLE_REPLACEMENT (404) instead of
   * returning an empty `eligibleReplacements` array when there ARE
   * affected leads but no valid replacement exists - per the design doc's
   * flow diagram, "Filter replacement candidates" is part of the preview
   * step, and the interaction-state matrix shows these codes replacing the
   * whole picker's loaded state, not just leaving it empty.
   */
  async preview(
    actor: JwtPayload,
    teamId: string,
    userId: string,
  ): Promise<RemovalPreviewResponse> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const t = tx as unknown as Tx;
      await this.assertCanMutate(t, actor, teamId);
      const team = await this.loadActiveTeam(t, teamId);
      await this.assertOrdinaryMember(t, teamId, userId);

      const leads = await t.lead.findMany({
        where: {
          teamId,
          OR: [{ ownerId: userId }, { coOwnerId: userId }],
          // T-SOFT-DELETE (2026-10-01): a lead on a soft-deleted project is
          // not work, so it must not appear in - or block - a removal preview.
          ...LEAD_IN_ACTIVE_PROJECT,
        },
        select: {
          id: true,
          updatedAt: true,
          ownerId: true,
          coOwnerId: true,
          state: true,
          projectId: true,
          project: { select: { name: true } },
        },
      });
      if (leads.length > MAX_AFFECTED_LEADS) {
        throw new CodedConflictException(
          'TOO_MANY_AFFECTED_LEADS',
          `${leads.length} leads are affected, above the ${MAX_AFFECTED_LEADS} cap for this operation. Use the admin bulk-transfer tool first.`,
          { affectedCount: leads.length, cap: MAX_AFFECTED_LEADS },
        );
      }

      const owned = leads.filter((l) => l.ownerId === userId);
      const coOwned = leads.filter((l) => l.coOwnerId === userId);
      const ownedStates = Array.from(new Set(owned.map((l) => l.state)));

      const projectSummaries = new Map<
        string,
        { projectId: string; projectName: string; ownedCount: number; coOwnedCount: number }
      >();
      const bump = (
        projectId: string | null,
        projectName: string | null,
        field: 'ownedCount' | 'coOwnedCount',
      ): void => {
        if (projectId === null) return;
        const existing = projectSummaries.get(projectId) ?? {
          projectId,
          projectName: projectName ?? 'Unknown project',
          ownedCount: 0,
          coOwnedCount: 0,
        };
        existing[field] += 1;
        projectSummaries.set(projectId, existing);
      };
      for (const l of owned) bump(l.projectId, l.project?.name ?? null, 'ownedCount');
      for (const l of coOwned) bump(l.projectId, l.project?.name ?? null, 'coOwnedCount');

      let eligibleReplacements: ReplacementCandidate[] = [];
      if (leads.length > 0) {
        const pool = await this.candidatePool(t, teamId, team.managerId, userId);
        if (pool.length === 0) {
          throw new CodedNotFoundException(
            'LAST_TEAM_PARTICIPANT',
            'No other team member exists to receive these leads. Add another team member before removing this person.',
          );
        }
        eligibleReplacements = pool
          .filter((c) => ownedStates.every((state) => canRoleOwnState(state, c.role)))
          .map((c) => ({ userId: c.userId, name: c.name, role: c.role, isTeamManager: c.isTeamManager }));
        if (eligibleReplacements.length === 0) {
          throw new CodedNotFoundException(
            'NO_ELIGIBLE_REPLACEMENT',
            'No same-team candidate can own every state among this person\'s leads. Reassign the incompatible leads through the Leads page first.',
          );
        }
      }

      const previewToken = computePreviewToken(leads);
      return {
        teamId,
        userId,
        ownedCount: owned.length,
        coOwnedCount: coOwned.length,
        totalAffectedLeads: leads.length,
        projects: Array.from(projectSummaries.values()).sort((a, b) =>
          a.projectName.localeCompare(b.projectName),
        ),
        ownedStates,
        eligibleReplacements,
        previewToken,
      };
    });
  }

  /**
   * POST /api/teams/:teamId/members/:userId/reassign-and-remove.
   *
   * Idempotent on `requestId`: if a membership-removal audit row already
   * carries this exact requestId, replays succeed by returning the stored
   * result (design doc: "If the membership is already absent and a
   * matching successful audit exists, return the stored result; a
   * different request receives 404"). If the membership is already
   * absent and NO matching audit exists, there's nothing to redo - 404.
   */
  async reassignAndRemove(
    actor: JwtPayload,
    teamId: string,
    userId: string,
    dto: ReassignAndRemoveDto,
  ): Promise<ReassignAndRemoveResponse> {
    if (dto.replacementUserId !== undefined && dto.replacementUserId !== null && dto.replacementUserId === userId) {
      throw new CodedBadRequestException(
        'SELF_REPLACEMENT',
        'The replacement cannot be the same person being removed.',
      );
    }

    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const t = tx as unknown as Tx;
      await this.assertCanMutate(t, actor, teamId);

      // Idempotency short-circuit BEFORE the locking transaction below -
      // a replay of an already-completed removal must not re-lock rows
      // that may no longer exist in the shape this request expects.
      const existingAudit = await t.auditLog.findUnique({
        where: { requestId: dto.requestId },
      });
      const membershipRow = await t.teamMember.findUnique({
        where: { userId_teamId: { userId, teamId } },
      });
      if (existingAudit !== null) {
        const payload = existingAudit.after as {
          removedUserId?: string;
          teamId?: string;
        } | null;
        if (payload?.removedUserId === userId && payload.teamId === teamId) {
          return this.responseFromAudit(existingAudit);
        }
        // requestId reused for a DIFFERENT removal - not this operation.
        throw new NotFoundException(
          `No pending removal matches requestId ${dto.requestId}.`,
        );
      }
      if (membershipRow === null) {
        throw new CodedNotFoundException(
          'TARGET_NOT_TEAM_MEMBER',
          `User ${userId} is not currently a member of team ${teamId}.`,
        );
      }

      // Lock the Team row FIRST (serializes concurrent same-team
      // removals), then the TeamMember row, then every affected Lead -
      // ORDER BY id fixes lock-acquisition order across concurrent
      // removals touching overlapping leads (deadlock avoidance).
      await t.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`,
      );
      const team = await this.loadActiveTeam(t, teamId);

      const lockedMember = await t.$queryRaw<Array<{ userId: string }>>(
        Prisma.sql`SELECT "userId" FROM "TeamMember" WHERE "userId" = ${userId} AND "teamId" = ${teamId} FOR UPDATE`,
      );
      if (lockedMember.length === 0) {
        throw new CodedConflictException(
          'CONCURRENT_MEMBERSHIP_CHANGE',
          `${userId} was removed from this team by another request. Reload and try again.`,
        );
      }

      const lockedLeads = await t.$queryRaw<
        Array<{ id: string; updatedAt: Date; ownerId: string; coOwnerId: string | null; state: LeadState; projectId: string | null }>
      >(
        Prisma.sql`
          SELECT "id", "updatedAt", "ownerId", "coOwnerId", "state", "projectId"
          FROM "Lead"
          WHERE "teamId" = ${teamId} AND ("ownerId" = ${userId} OR "coOwnerId" = ${userId})
          ORDER BY "id"
          FOR UPDATE
        `,
      );
      if (lockedLeads.length > MAX_AFFECTED_LEADS) {
        throw new CodedConflictException(
          'TOO_MANY_AFFECTED_LEADS',
          `${lockedLeads.length} leads are affected, above the ${MAX_AFFECTED_LEADS} cap for this operation.`,
          { affectedCount: lockedLeads.length, cap: MAX_AFFECTED_LEADS },
        );
      }

      const snapshots: LeadOwnershipSnapshot[] = lockedLeads.map((l) => ({
        id: l.id,
        updatedAt: l.updatedAt,
        ownerId: l.ownerId,
        coOwnerId: l.coOwnerId,
      }));
      const freshToken = computePreviewToken(snapshots);
      if (freshToken !== dto.previewToken) {
        throw new CodedConflictException(
          'STALE_PREVIEW',
          'The affected leads changed since you last previewed this removal. Refresh and try again.',
        );
      }

      const owned = lockedLeads.filter((l) => l.ownerId === userId);
      const hasReplacement = dto.replacementUserId !== undefined && dto.replacementUserId !== null;
      if (lockedLeads.length > 0 && !hasReplacement) {
        throw new CodedBadRequestException(
          'REPLACEMENT_REQUIRED',
          'A replacement is required because this person owns or co-owns leads on this team.',
        );
      }
      if (lockedLeads.length === 0 && hasReplacement) {
        throw new CodedBadRequestException(
          'REPLACEMENT_NOT_ALLOWED',
          'No leads are affected - do not supply a replacement for a plain removal.',
        );
      }

      let replacementUserId: string | null = null;
      let replacementName: string | null = null;
      if (hasReplacement) {
        replacementUserId = dto.replacementUserId as string;
        const candidate = await this.resolveCandidate(t, teamId, team.managerId, replacementUserId);
        if (candidate === null) {
          throw new CodedBadRequestException(
            'TARGET_NOT_TEAM_MEMBER',
            `${replacementUserId} is not a member of team ${teamId} and cannot receive these leads.`,
          );
        }
        replacementName = candidate.name;
        const ownedStates = Array.from(new Set(owned.map((l) => l.state)));
        if (!ownedStates.every((state) => canRoleOwnState(state, candidate.role))) {
          throw new CodedBadRequestException(
            'TARGET_ROLE_INELIGIBLE',
            `${candidate.name} (${candidate.role}) cannot own every lead state this removal would transfer.`,
          );
        }
      }

      const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      let transferredLeadCount = 0;

      if (replacementUserId !== null && lockedLeads.length > 0) {
        const plan = planOwnershipTransfer(snapshots, userId, replacementUserId);
        const auditRows: Prisma.AuditLogCreateManyInput[] = [];
        const now = new Date();

        if (plan.promoteCoOwnerToOwnerLeadIds.length > 0) {
          await t.lead.updateMany({
            where: { id: { in: plan.promoteCoOwnerToOwnerLeadIds } },
            data: { ownerId: replacementUserId, coOwnerId: null },
          });
        }
        if (plan.reassignOwnerLeadIds.length > 0) {
          await t.lead.updateMany({
            where: { id: { in: plan.reassignOwnerLeadIds } },
            data: { ownerId: replacementUserId },
          });
        }
        if (plan.clearCoOwnerLeadIds.length > 0) {
          await t.lead.updateMany({
            where: { id: { in: plan.clearCoOwnerLeadIds } },
            data: { coOwnerId: null },
          });
        }
        if (plan.reassignCoOwnerLeadIds.length > 0) {
          await t.lead.updateMany({
            where: { id: { in: plan.reassignCoOwnerLeadIds } },
            data: { coOwnerId: replacementUserId },
          });
        }

        const byId = new Map(lockedLeads.map((l) => [l.id, l]));
        for (const leadId of [
          ...plan.promoteCoOwnerToOwnerLeadIds,
          ...plan.reassignOwnerLeadIds,
          ...plan.clearCoOwnerLeadIds,
          ...plan.reassignCoOwnerLeadIds,
        ]) {
          const before = byId.get(leadId);
          if (before === undefined) continue;
          const isClear = plan.clearCoOwnerLeadIds.includes(leadId);
          const after = {
            ownerId:
              plan.promoteCoOwnerToOwnerLeadIds.includes(leadId) || plan.reassignOwnerLeadIds.includes(leadId)
                ? replacementUserId
                : before.ownerId,
            coOwnerId:
              plan.promoteCoOwnerToOwnerLeadIds.includes(leadId) || isClear
                ? null
                : plan.reassignCoOwnerLeadIds.includes(leadId)
                  ? replacementUserId
                  : before.coOwnerId,
          };
          auditRows.push({
            userId: actor.sub,
            organizationId: actor.organizationId,
            action: 'lead.ownership_transfer',
            entityType: 'Lead',
            entityId: leadId,
            before: { ownerId: before.ownerId, coOwnerId: before.coOwnerId },
            after,
            reason: `team.member.remove batch transfer by ${actor.email} (${actor.role})`,
            batchId,
            createdAt: now,
          });
        }
        if (auditRows.length > 0) {
          await t.auditLog.createMany({ data: auditRows });
        }
        transferredLeadCount = auditRows.length;
      }

      await t.teamMember.delete({ where: { userId_teamId: { userId, teamId } } });

      // T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI6): resolve display
      // names for the Audit page's batch-summary copy ("{member} removed
      // from {team} · {n} leads transferred to {replacement}") - the audit
      // payload otherwise carries only ids, which aren't renderable there.
      const [removedUser, teamRow] = await Promise.all([
        t.user.findUnique({ where: { id: userId }, select: { name: true } }),
        t.team.findUnique({ where: { id: teamId }, select: { name: true } }),
      ]);

      const removalAuditPayload = {
        removedUserId: userId,
        removedUserName: removedUser?.name ?? null,
        teamId,
        teamName: teamRow?.name ?? null,
        replacementUserId,
        replacementName,
        transferredLeadCount,
      };
      await t.auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: actor.organizationId,
          action: 'team.member.remove',
          entityType: 'Team',
          entityId: teamId,
          before: { userId, teamId },
          after: removalAuditPayload,
          reason: dto.reason,
          batchId,
          requestId: dto.requestId,
        },
      });

      return {
        batchId,
        removedUserId: userId,
        teamId,
        replacementUserId,
        transferredLeadCount,
      };
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * PATCH /api/teams/:teamId/members/:userId/weight (T-AUTOASSIGN, 2026-09-17).
   * Update a member's routing weight for the auto-assign lead engine.
   * ADMIN/OWNER (or the team's manager) only - mirrors `assertCanMutate`.
   * The weight is persisted on the TeamMember row; higher = gets more leads.
   */
  async updateWeight(
    actor: JwtPayload,
    teamId: string,
    userId: string,
    dto: UpdateTeamMemberWeightDto,
  ): Promise<{ userId: string; teamId: string; weight: number }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const t = tx as unknown as Tx;
      await this.assertCanMutate(t, actor, teamId);

      const membership = await t.teamMember.findUnique({
        where: { userId_teamId: { userId, teamId } },
      });
      if (membership === null) {
        throw new CodedNotFoundException(
          'TARGET_NOT_TEAM_MEMBER',
          `User ${userId} is not a member of team ${teamId}.`,
        );
      }

      const updated = await t.teamMember.update({
        where: { userId_teamId: { userId, teamId } },
        data: { weight: dto.weight },
      });

      await t.auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: actor.organizationId,
          action: 'team.member.weight',
          entityType: 'Team',
          entityId: teamId,
          before: { userId, teamId, weight: membership.weight },
          after: { userId, teamId, weight: updated.weight },
          reason: `team.member.weight by ${actor.email} (${actor.role})`,
        },
      });

      return { userId, teamId, weight: updated.weight };
    });
  }

  /**
   * PATCH /api/teams/:teamId/members/:userId/cap (T-MAXOPENLEADS, 2026-09-28).
   * Set or clear a member's hard ceiling on open leads for the auto-assign
   * engine. ADMIN/OWNER (or the team's manager) only - mirrors `updateWeight`.
   *
   * `maxOpenLeads: null` clears the cap. 0 is a real ceiling ("send them
   * nothing"), not "unset" - see the DTO.
   */
  async updateCap(
    actor: JwtPayload,
    teamId: string,
    userId: string,
    dto: UpdateTeamMemberCapDto,
  ): Promise<{ userId: string; teamId: string; maxOpenLeads: number | null }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const t = tx as unknown as Tx;
      await this.assertCanMutate(t, actor, teamId);

      const membership = await t.teamMember.findUnique({
        where: { userId_teamId: { userId, teamId } },
      });
      if (membership === null) {
        throw new CodedNotFoundException(
          'TARGET_NOT_TEAM_MEMBER',
          `User ${userId} is not a member of team ${teamId}.`,
        );
      }

      const updated = await t.teamMember.update({
        where: { userId_teamId: { userId, teamId } },
        data: { maxOpenLeads: dto.maxOpenLeads },
      });

      // Audit in the SAME transaction as the write (AGENTS.md high-stakes rule):
      // a ceiling change silently alters who receives new leads.
      await t.auditLog.create({
        data: {
          userId: actor.sub,
          organizationId: actor.organizationId,
          action: 'team.member.cap',
          entityType: 'Team',
          entityId: teamId,
          before: { userId, teamId, maxOpenLeads: membership.maxOpenLeads },
          after: { userId, teamId, maxOpenLeads: updated.maxOpenLeads },
          reason: `team.member.cap by ${actor.email} (${actor.role})`,
        },
      });

      return { userId, teamId, maxOpenLeads: updated.maxOpenLeads };
    });
  }

  private async assertCanMutate(tx: Tx, actor: JwtPayload, teamId: string): Promise<void> {
    const allowed = await this.teamAccess.canMutateTeam(tx as never, actor, teamId);
    if (!allowed) {
      throw new ForbiddenException(
        'Only ADMIN, OWNER, or the team\'s manager may remove a member from this team.',
      );
    }
  }

  private async loadActiveTeam(
    tx: Tx,
    teamId: string,
  ): Promise<{ id: string; managerId: string | null }> {
    const team = await tx.team.findUnique({ where: { id: teamId } });
    if (team === null || team.deletedAt !== null) {
      throw new NotFoundException(`Team ${teamId} not found.`);
    }
    return team;
  }

  private async assertOrdinaryMember(tx: Tx, teamId: string, userId: string): Promise<void> {
    const membership = await tx.teamMember.findUnique({
      where: { userId_teamId: { userId, teamId } },
    });
    if (membership === null) {
      throw new CodedNotFoundException(
        'TARGET_NOT_TEAM_MEMBER',
        `User ${userId} is not an ordinary member of team ${teamId} (they may only manage it, or not belong to it at all).`,
      );
    }
  }

  /**
   * Every same-team, non-admin candidate EXCLUDING the departing user:
   * ordinary `TeamMember` rows plus the team's manager (deduped - a
   * manager who also holds an ordinary row for this same team is not
   * double-listed).
   */
  private async candidatePool(
    tx: Tx,
    teamId: string,
    managerId: string | null,
    excludeUserId: string,
  ): Promise<CandidateMember[]> {
    const memberRows = await tx.teamMember.findMany({
      where: { teamId, userId: { not: excludeUserId } },
      include: { user: { select: { name: true, role: true } } },
    });
    const pool: CandidateMember[] = memberRows
      .filter((m) => CANDIDATE_ROLES.includes(m.user.role))
      .map((m) => ({ userId: m.userId, name: m.user.name, role: m.user.role, isTeamManager: false }));

    if (managerId !== null && managerId !== excludeUserId && !pool.some((c) => c.userId === managerId)) {
      const manager = await tx.user.findUnique({
        where: { id: managerId },
        select: { name: true, role: true },
      });
      if (manager !== null && CANDIDATE_ROLES.includes(manager.role)) {
        pool.push({ userId: managerId, name: manager.name, role: manager.role, isTeamManager: true });
      }
    }
    return pool;
  }

  /** Resolve one candidate by id (used to validate a caller-supplied
   * replacementUserId at execute time, mirroring `candidatePool`'s rules). */
  private async resolveCandidate(
    tx: Tx,
    teamId: string,
    managerId: string | null,
    candidateUserId: string,
  ): Promise<CandidateMember | null> {
    if (candidateUserId === managerId) {
      const manager = await tx.user.findUnique({
        where: { id: candidateUserId },
        select: { name: true, role: true },
      });
      if (manager === null || !CANDIDATE_ROLES.includes(manager.role)) return null;
      return { userId: candidateUserId, name: manager.name, role: manager.role, isTeamManager: true };
    }
    const membership = await tx.teamMember.findUnique({
      where: { userId_teamId: { userId: candidateUserId, teamId } },
      include: { user: { select: { name: true, role: true } } },
    });
    if (membership === null || !CANDIDATE_ROLES.includes(membership.user.role)) return null;
    return {
      userId: candidateUserId,
      name: membership.user.name,
      role: membership.user.role,
      isTeamManager: false,
    };
  }

  private responseFromAudit(audit: {
    batchId: string | null;
    after: unknown;
  }): ReassignAndRemoveResponse {
    const payload = audit.after as {
      removedUserId: string;
      teamId: string;
      replacementUserId: string | null;
      transferredLeadCount: number;
    };
    return {
      batchId: audit.batchId ?? '',
      removedUserId: payload.removedUserId,
      teamId: payload.teamId,
      replacementUserId: payload.replacementUserId,
      transferredLeadCount: payload.transferredLeadCount,
    };
  }
}
