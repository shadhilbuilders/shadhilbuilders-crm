// Users service - the user-creation + role-change model (Rounds 17–21).
//
// OWNER (exactly one, seed-only): creates any role except OWNER;
// changes the role of anyone. ADMIN: creates/changes
// MANAGER/TELECALLER/SALES_EXEC. MANAGER: creates TELECALLER/SALES_EXEC in
// their own team. Staff roles: nothing.
//
// Guards on changeRole (client-confirmed Round 20, rename 21): no
// self-role-changes; only OWNER touches ADMIN rows (rank check covers
// this); never assign or revoke OWNER; demoting a manager who still
// leads a team is blocked until members move.
//
// Write paths:
//   - User/Account/Team: bare prisma client (no RLS on auth tables; Team is
//     RLS-FORCED with zero policies, so the app role cannot write it inside
//     an RLS context - seed.ts precedent).
//   - AuditLog: withRlsContext (its insert policy requires app.user_id).
//     OWNER travels as ADMIN at the RLS layer (downcast in rls.ts).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withRlsContext, rlsContextFrom, type Role, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { AssignManagerDto, CreateUserDto, ChangePasswordDto, ChangeRoleDto, UpdateUserDto, UserDetail, UserFilterDto, UserListResult } from '@shadhil/api-types';
import { PrismaService } from '../prisma/prisma.module';
import { assertCanCreateRole, assertCanChangeRole, isAdminClass, outranks, OWNER } from './roles';
import { hashPassword, upsertCredentialAccount, verifyPassword } from './credentials';

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
}

@Injectable()
export class UsersService {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime. PrismaService is exported from prisma.module.ts.
  constructor(
    @Inject(PrismaService) private readonly prismaService: PrismaService,
  ) {}

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /**
   * T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): resolves the single
   * "display team" for a user's `CreatedUser.teamId`/`UserDetail.teamId`
   * response field, now that `User.teamId` is gone. A MANAGER's team is
   * the one they lead (Team.managerId); everyone else's is their first
   * (oldest-assigned) ordinary TeamMember row, or null if they have none.
   * This preserves the pre-cutover single-team-per-user CONTRACT for
   * these legacy response shapes even though the underlying model now
   * supports multiple TeamMember rows per user.
   */
  private async resolveDisplayTeamId(
    userId: string,
    role: string,
  ): Promise<string | null> {
    if (role === 'MANAGER') {
      const led = await this.client.team.findFirst({
        where: { managerId: userId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      return led?.id ?? null;
    }
    const membership = await this.client.teamMember.findFirst({
      where: { userId },
      orderBy: { assignedAt: 'asc' },
    });
    return membership?.teamId ?? null;
  }

  async create(actor: JwtPayload, dto: CreateUserDto): Promise<CreatedUser> {
    const actorRole = actor.role;
    const actorIsManager = actorRole === 'MANAGER';
    // Org-owner class: OWNER behaves like ADMIN on this surface
    // (create into any team; auto-team for MANAGER targets).
    const actorIsOrgOwner = actorRole === 'OWNER' || actorRole === 'ADMIN';

    // 1. Role hierarchy gate (fails closed for any staff role).
    assertCanCreateRole(actorRole, dto.role);

    // 2. Resolve the target team.
    let teamId = dto.teamId ?? null;

    if (actorIsManager) {
      // T-TEAM-AUTHORITATIVE (2026-09-13): the manager's team(s) are
      // resolved authoritatively via Team.managerId (a manager may lead
      // multiple teams) - the JWT teamId claim is unreliable (seeded
      // managers carry teamId=null; the team links through managerId
      // instead). An explicit dto.teamId must be one of THEIR teams;
      // omitted defaults to their first (oldest) managed team.
      const managedTeams = await this.client.team.findMany({
        where: { managerId: actor.sub, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (managedTeams.length === 0) {
        throw new ForbiddenException('You do not manage any team');
      }
      if (dto.teamId !== undefined) {
        if (!managedTeams.some((t) => t.id === dto.teamId)) {
          throw new ForbiddenException(
            'You can only create users in a team you manage',
          );
        }
        teamId = dto.teamId;
      } else {
        teamId = managedTeams[0]!.id;
      }
    } else if (actorIsOrgOwner && dto.role !== 'ADMIN' && !dto.teamId) {
      // Admin creating a manager WITHOUT teamId: auto-create the team.
      // Admin creating a STAFF user without teamId: reject - ambiguous.
      if (dto.role === 'MANAGER') {
        // Handled post-user-creation (needs the user id).
      } else {
        throw new BadRequestException(
          'teamId is required when an admin creates TELECALLER/SALES_EXEC users',
        );
      }
    }

    // 3. Reject a stale teamId that doesn't exist (pre-FK clarity).
    if (teamId) {
      const team = await this.client.team.findUnique({ where: { id: teamId } });
      if (!team) {
        throw new NotFoundException(`Team ${teamId} not found`);
      }
    }

    // 4. Create user + credential + (team for new managers) + TeamMember
    //    row + audit row. All pre-audit writes on the bare client; audit
    //    inside RLS context.
    //
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): User.teamId is gone
    // - TeamMember is the sole membership record now. A TELECALLER/
    // SALES_EXEC (or a MANAGER's own ordinary membership, if ever given
    // one through this path) gets a TeamMember row for `teamId` instead of
    // a scalar column write.
    const created = await this.client.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        role: dto.role,
        emailVerified: false,
        organizationId: actor.organizationId,
      },
    });

    try {
      await upsertCredentialAccount(this.client, created.id, dto.password);

      // Auto-create the team for a new manager (org-owner creating
      // MANAGER without an explicit teamId). A manager's OWN leadership is
      // Team.managerId, not a TeamMember row - no membership row needed.
      if (dto.role === 'MANAGER' && actorIsOrgOwner && !dto.teamId) {
        const team = await this.client.team.create({
          data: {
            name: `${dto.name}'s Team`,
            managerId: created.id,
            organizationId: actor.organizationId,
          },
        });
        teamId = team.id;
      } else if (teamId !== null) {
        // TELECALLER/SALES_EXEC (or a manager given an explicit team they
        // don't lead) get an ordinary TeamMember row.
        await this.client.teamMember.create({
          data: {
            userId: created.id,
            teamId,
            organizationId: actor.organizationId,
            assignedById: actor.sub,
          },
        });
      }

      // Audit row - the only write inside an RLS transaction.
      await withRlsContext(
        this.client,
        rlsContextFrom(actor),
        async (tx) => {
          await tx.auditLog.create({
            data: {
              userId: actor.sub,
              action: 'user.create',
              organizationId: actor.organizationId,
              entityType: 'User',
              entityId: created.id,
              after: {
                email: created.email,
                role: created.role,
                createdBy: actor.sub,
              },
              reason: `user.create by ${actor.email} (${actor.role})`,
            },
          });
        },
      );
    } catch (err) {
      // Credential/audit failure: don't leave a user that can't sign in.
      await this.client.user
        .delete({ where: { id: created.id } })
        .catch(() => undefined);
      throw err;
    }

    return {
      id: created.id,
      email: created.email,
      name: created.name,
      role: created.role,
      teamId: teamId ?? null,
    };
  }

  async changeRole(
    actor: JwtPayload,
    targetUserId: string,
    dto: ChangeRoleDto,
  ): Promise<CreatedUser> {
    // 1. Target must exist.
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // 2. Absolute guard: nobody changes their own role (not even the
    //    owner - role changes on self are how orgs get locked out).
    if (target.id === actor.sub) {
      throw new ForbiddenException('You cannot change your own role');
    }

    // 3. Role-level hierarchy (includes: OWNER unassignable,
    //    only owner touches ADMIN rows, actor must strictly outrank both
    //    the target's current role and the new role).
    assertCanChangeRole(actor.role, target.role as Role, dto.role);

    // 4. Demotion guard: a manager still leading a team cannot be demoted.
    if (target.role === 'MANAGER' && dto.role !== 'MANAGER') {
      const ledTeam = await this.client.team.findFirst({
        where: { managerId: target.id },
      });
      if (ledTeam) {
        throw new ConflictException(
          `User still leads team "${ledTeam.name}" - move its members or reassign the team before demoting`,
        );
      }
    }

    // 5. Promotion to MANAGER: ensure a team exists (consistent with the
    //    create flow - managers always lead exactly one team). A role
    //    change does NOT touch the target's ordinary TeamMember row(s) -
    //    that's a separate concern from role/leadership, and the demotion
    //    guard above already blocks demoting a manager who still leads a
    //    team, so there's nothing to clean up on the way down either.
    if (dto.role === 'MANAGER' && target.role !== 'MANAGER') {
      const existing = await this.client.team.findFirst({
        where: { managerId: target.id },
      });
      if (!existing) {
        await this.client.team.create({
          data: { name: `${target.name}'s Team`, managerId: target.id, organizationId: actor.organizationId },
        });
      }
    }

    const updated = await this.client.user.update({
      where: { id: target.id },
      data: { role: dto.role },
    });
    const teamId = await this.resolveDisplayTeamId(updated.id, updated.role);

    // 6. Audit row in the actor's RLS context (OWNER downcasts to
    //    ADMIN there - rls.ts).
    await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.changeRole',
            organizationId: actor.organizationId,
            entityType: 'User',
            entityId: target.id,
            before: { role: target.role },
            after: { role: dto.role },
            reason: `role change by ${actor.email} (${actor.role})`,
          },
        });
      },
    );

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      teamId,
    };
  }

  /**
   * PATCH /api/users/:id - edit a user's name/email (autoplan 2026-09-09).
   * Hierarchy-gated: the actor must strictly outrank the target (no
   * self-edit, OWNER protected). Mirrors the changeRole guards.
   */
  async update(
    actor: JwtPayload,
    targetUserId: string,
    dto: UpdateUserDto,
  ): Promise<CreatedUser> {
    // 1. Target must exist.
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // 2. No self-edit (an admin shouldn't rename their own account here;
    //    self-profile editing is a separate surface).
    if (target.id === actor.sub) {
      throw new ForbiddenException('You cannot edit your own user');
    }

    // 3. Hierarchy: actor must strictly outrank the target. OWNER is
    //    protected (nobody outranks it).
    if (!outranks(actor.role, target.role as Role)) {
      throw new ForbiddenException(
        `${actor.role} cannot edit a ${target.role} user`,
      );
    }

    // 4. Apply the update (only the provided fields).
    const data: { name?: string; email?: string } = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;

    const updated = await this.client.user.update({
      where: { id: target.id },
      data,
    });

    // 5. Audit row in the actor's RLS context.
    await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.update',
            organizationId: actor.organizationId,
            entityType: 'User',
            entityId: target.id,
            before: { name: target.name, email: target.email },
            after: { name: updated.name, email: updated.email },
            reason: `user.update by ${actor.email} (${actor.role})`,
          },
        });
      },
    );

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      teamId: await this.resolveDisplayTeamId(updated.id, updated.role),
    };
  }

  /**
   * DELETE /api/users/:id - SOFT delete a user (autoplan 2026-09-09).
   * ADMIN/OWNER only. Sets User.deletedAt (no hard delete): the account row
   * is kept so audit/history survive, but the user cannot sign in and is
   * hidden from every list/picker. No self-delete; OWNER is protected.
   */
  async remove(
    actor: JwtPayload,
    targetUserId: string,
  ): Promise<{ ok: true }> {
    // 0. Admin/owner only.
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can delete users.');
    }

    // 1. Target must exist + not already deleted + not OWNER.
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }
    if (target.role === OWNER) {
      throw new ForbiddenException('The OWNER cannot be deleted.');
    }

    // 2. No self-delete.
    if (target.id === actor.sub) {
      throw new ForbiddenException('You cannot delete your own user');
    }

    // 3. Soft delete: stamp deletedAt (keep the account row).
    await this.client.user.update({
      where: { id: target.id },
      data: { deletedAt: new Date() },
    });

    // 4. Audit row in the actor's RLS context.
    await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.delete',
            organizationId: actor.organizationId,
            entityType: 'User',
            entityId: target.id,
            before: { name: target.name, email: target.email, role: target.role },
            reason: `user.delete (soft) by ${actor.email} (${actor.role})`,
          },
        });
      },
    );

    return { ok: true };
  }

  /**
   * GET /api/users/:id - the user detail page (users/[userId], autoplan
   * 2026-09-13). Scope mirrors `list()`: OWNER/ADMIN see anyone; MANAGER
   * sees their own team's members (+ themselves); staff see only
   * themselves. `manager` is populated only for TELECALLER/SALES_EXEC
   * whose team has an assigned manager - MANAGER/ADMIN/OWNER report to
   * nobody on this surface.
   */
  async getUser(actor: JwtPayload, targetUserId: string): Promise<UserDetail> {
    const target = await this.client.user.findUnique({
      where: { id: targetUserId, deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    });
    if (target === null) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): User.teamId/the
    // legacy singular `team` relation are gone - resolve the target's
    // display team via the same rule as create()/changeRole()
    // (resolveDisplayTeamId), then fetch that team's manager + linked
    // projects (ProjectTeam) separately.
    const teamId = await this.resolveDisplayTeamId(target.id, target.role);
    const team =
      teamId !== null
        ? await this.client.team.findUnique({
            where: { id: teamId },
            select: {
              id: true,
              name: true,
              manager: { select: { id: true, name: true, email: true } },
              // "Which projects" is "which projects is this user's TEAM
              // linked to" (ProjectTeam) - ProjectMember (per-user
              // linking) was retired. Read-only here (linking happens on
              // the project's Staff page, at the team level).
              projectTeams: {
                select: { project: { select: { id: true, name: true } } },
                orderBy: { project: { name: 'asc' } },
              },
            },
          })
        : null;

    // Scope check - mirrors list()'s role lanes.
    if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
      // sees anyone.
    } else if (actor.role === 'MANAGER') {
      // T-TEAM-AUTHORITATIVE (2026-09-13): a manager may lead multiple
      // teams - check membership in the FULL managed-team set.
      const teams = await this.client.team.findMany({
        where: { managerId: actor.sub, deletedAt: null },
        select: { id: true },
      });
      const inOwnTeam = teamId !== null && teams.some((t) => t.id === teamId);
      if (!inOwnTeam && target.id !== actor.sub) {
        throw new ForbiddenException("You can only view your own team's users");
      }
    } else if (target.id !== actor.sub) {
      throw new ForbiddenException('You can only view your own user');
    }

    // Manager is a reporting-line concept: only staff (TELECALLER/
    // SALES_EXEC) report to a manager on this surface.
    const reportsToManager = target.role === 'TELECALLER' || target.role === 'SALES_EXEC';

    return {
      id: target.id,
      email: target.email,
      name: target.name,
      role: target.role,
      teamId,
      teamName: team?.name ?? null,
      manager:
        reportsToManager && team?.manager
          ? {
              id: team.manager.id,
              name: team.manager.name,
              email: team.manager.email,
            }
          : null,
      projects: (team?.projectTeams ?? []).map((pt) => ({
        id: pt.project.id,
        name: pt.project.name,
      })),
    };
  }

  /**
   * PATCH /api/users/:id/manager - assign/reassign the manager for a
   * TELECALLER/SALES_EXEC (autoplan 2026-09-13). "Manager" is a
   * reporting-line concept derived from `Team.managerId`, so this replaces
   * the target's ordinary TeamMember row(s) with one for the chosen team.
   * Scope:
   *   - OWNER/ADMIN: assign to any existing (led) team.
   *   - MANAGER: only into their OWN team - they can't poach staff into
   *     another manager's team. In practice `getUser`'s scope check
   *     already means a MANAGER only reaches this for a user already in
   *     their own team, but the team-ownership check here is the actual
   *     gate (belt-and-braces, same pattern as `list()`'s where-clause
   *     comment).
   *   - staff: never - `outranks()` fails closed (RANK[staff] never
   *     exceeds RANK[staff]).
   */
  async assignManager(
    actor: JwtPayload,
    targetUserId: string,
    dto: AssignManagerDto,
  ): Promise<CreatedUser> {
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // 1. Only TELECALLER/SALES_EXEC report to a manager on this surface.
    if (target.role !== 'TELECALLER' && target.role !== 'SALES_EXEC') {
      throw new BadRequestException(
        'Only TELECALLER/SALES_EXEC report to a manager',
      );
    }

    // 2. Hierarchy: actor must strictly outrank the target (mirrors
    //    update()/changeRole() - no self-service).
    if (!outranks(actor.role, target.role as Role)) {
      throw new ForbiddenException(
        `${actor.role} cannot reassign this user's manager`,
      );
    }

    // 3. Target team must exist and have a manager - assigning into an
    //    unled team would make "manager" mean nothing.
    const team = await this.client.team.findUnique({
      where: { id: dto.teamId },
      select: { id: true, name: true, managerId: true },
    });
    if (!team) {
      throw new NotFoundException(`Team ${dto.teamId} not found`);
    }
    if (team.managerId === null) {
      throw new BadRequestException(
        `Team "${team.name}" has no manager assigned yet`,
      );
    }

    // 4. MANAGER scope: only into their own team.
    if (actor.role === 'MANAGER' && team.managerId !== actor.sub) {
      throw new ForbiddenException(
        'Managers can only assign staff into their own team',
      );
    }

    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): "assign into this
    // team" now means "replace their ordinary TeamMember row(s) with one
    // for the chosen team" - this endpoint models a single-team move for
    // TELECALLER/SALES_EXEC, mirroring reassignMembers()'s move semantics.
    const beforeTeamId = await this.resolveDisplayTeamId(target.id, target.role);
    await this.client.teamMember.deleteMany({ where: { userId: target.id } });
    await this.client.teamMember.create({
      data: {
        userId: target.id,
        teamId: dto.teamId,
        organizationId: actor.organizationId,
        assignedById: actor.sub,
      },
    });
    const updated = target;

    // 5. Audit row in the actor's RLS context.
    await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.assignManager',
            organizationId: actor.organizationId,
            entityType: 'User',
            entityId: target.id,
            before: { teamId: beforeTeamId },
            after: { teamId: dto.teamId },
            reason: `manager reassigned by ${actor.email} (${actor.role})`,
          },
        });
      },
    );

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      teamId: dto.teamId,
    };
  }

  /**
   * T-S hardening (2026-09-04, Week 5):
   * POST /api/users/:id/change-password
   *
   * Change a user's password. The actor must be:
   *   - the target user themselves (self-service rotation after the
   *     mustChangePassword gate fires), OR
   *   - ADMIN / OWNER (admin reset, e.g. locked-out operator).
   *
   * Verifies the old password against the credential Account row
   * (scrypt-hashed with the same params the seed uses), then hashes
   * the new password and writes both Account.password and
   * User.mustChangePassword = false. The audit row records who did
   * what and the user being changed (the actor is the writer; the
   * entity is the User row).
   *
   * 404 if the target user doesn't exist; 403 if the actor isn't
   * self/admin/owner; 400 if the old password is wrong.
   */
  async changePassword(
    actor: JwtPayload,
    targetUserId: string,
    dto: ChangePasswordDto,
  ): Promise<{ ok: true; mustChangePassword: false }> {
    // 1. Target must exist.
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, mustChangePassword: true },
    });
    if (target === null) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // 2. Role gate: self OR ADMIN/OWNER.
    const isSelf = target.id === actor.sub;
    const isPrivileged = actor.role === 'ADMIN' || actor.role === 'OWNER';
    if (!isSelf && !isPrivileged) {
      throw new ForbiddenException(
        'You can only change your own password (admin/owner can reset others)',
      );
    }

    // 3. Verify the old password against the credential Account row.
    // Account uses (providerId='credential', accountId=user.id) as the
    // better-auth 1.7 sign-in contract (see credentials.ts).
    const account = await this.client.account.findUnique({
      where: {
        providerId_accountId: {
          providerId: 'credential',
          accountId: target.id,
        },
      },
      select: { password: true },
    });
    if (
      account === null ||
      !verifyPassword(dto.oldPassword, account.password)
    ) {
      // 400 (not 401) - this is a request-body validation error from
      // the client's perspective. Same shape better-auth's sign-in uses
      // for wrong-password so a probe can't tell the difference between
      // "no such user" and "wrong password" by status code alone.
      throw new BadRequestException('Current password is incorrect');
    }

    // 4. Hash the new password + flip mustChangePassword. Bare client
    // is correct here - User/Account are auth tables without FORCE
    // RLS (same precedent as create()).
    await this.client.account.update({
      where: {
        providerId_accountId: {
          providerId: 'credential',
          accountId: target.id,
        },
      },
      data: {
        password: hashPassword(dto.newPassword),
        issuer: 'local:credential',
      },
    });
    await this.client.user.update({
      where: { id: target.id },
      data: { mustChangePassword: false },
    });

    // 5. Audit row in the actor's RLS context so the AuditLog policy
    // admits the insert (it gates on app.user_id).
    await withRlsContext(
      this.client,
      rlsContextFrom(actor),
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.changePassword',
            organizationId: actor.organizationId,
            entityType: 'User',
            entityId: target.id,
            before: { mustChangePassword: target.mustChangePassword },
            after: { mustChangePassword: false },
            reason: `password changed by ${actor.email} (${actor.role})`,
          },
        });
      },
    );

    return { ok: true, mustChangePassword: false };
  }

  async list(actor: JwtPayload, filter: UserFilterDto = { limit: 50, offset: 0 }): Promise<UserListResult> {
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): team scoping
    // resolves EVERY team via Team.managerId (a manager may lead multiple
    // teams) UNION the manager's own TeamMember rows, matching
    // TeamAccessService.getAccessibleTeamIds. OWNER and ADMIN see all. All
    // scopes exclude soft-deleted users. Membership is checked via the
    // TeamMember relation now - User.teamId is gone.
    let where: Record<string, unknown>;
    if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
      where = { deletedAt: null };
    } else if (actor.role === 'MANAGER') {
      const teams = await this.client.team.findMany({
        where: { managerId: actor.sub, deletedAt: null },
      });
      const teamIds = teams.map((t) => t.id);
      where = {
        deletedAt: null,
        teamMemberships:
          teamIds.length > 0
            ? { some: { teamId: { in: teamIds } } }
            : { some: { teamId: '__none__' } },
      };
    } else {
      where = { deletedAt: null, id: actor.sub };
    }

    // Server-driven role filter (autoplan 2026-09-09): the UI's MultiSelect
    // sends ?role=SALES_EXEC,TELECALLER; apply it as a WHERE role IN (...)
    // so filtering works across the whole list, not just the loaded page.
    if (filter.role !== undefined) {
      const roles = Array.isArray(filter.role) ? filter.role : [filter.role];
      where = { ...where, role: { in: roles } };
    }

    // Server-side search (autoplan 2026-09-09): the toolbar search input
    // sends ?search=...; match name OR email case-insensitively so search
    // works across the whole list, not just the loaded page.
    if (filter.search !== undefined && filter.search.length > 0) {
      where = {
        ...where,
        OR: [
          { name: { contains: filter.search, mode: 'insensitive' } },
          { email: { contains: filter.search, mode: 'insensitive' } },
        ],
      };
    }

    // Server-side pagination (T-SRVPG, mirrors leads): the DataTable
    // paginates client-side over the loaded page, which is wrong for large
    // sets. The page passes limit/offset and the service applies them in the
    // SQL, returning { rows, total } so the pagination control stays honest.
    const [rows, total] = await Promise.all([
      this.client.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): oldest
          // TeamMember row is this row's "display team" for non-managers
          // (resolveDisplayTeamId's rule) - a MANAGER's team is resolved
          // separately below via Team.managerId.
          teamMemberships: {
            select: { teamId: true },
            orderBy: { assignedAt: 'asc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: filter.offset,
        take: filter.limit,
      }),
      this.client.user.count({ where }),
    ]);

    // Resolve MANAGER rows' teams via Team.managerId (batched: fetch every
    // team led by any manager on this page, pick the oldest per manager -
    // matches resolveDisplayTeamId's single-row rule).
    const managerIds = rows.filter((r) => r.role === 'MANAGER').map((r) => r.id);
    const ledTeams =
      managerIds.length > 0
        ? await this.client.team.findMany({
            where: { managerId: { in: managerIds }, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, managerId: true },
          })
        : [];
    const ledTeamByManagerId = new Map<string, string>();
    for (const t of ledTeams) {
      if (t.managerId !== null && !ledTeamByManagerId.has(t.managerId)) {
        ledTeamByManagerId.set(t.managerId, t.id);
      }
    }

    const resolvedTeamIds = rows.map(
      (r) => (r.role === 'MANAGER' ? ledTeamByManagerId.get(r.id) : r.teamMemberships[0]?.teamId) ?? null,
    );

    // Project names for the admin Users table (autoplan 2026-09-12).
    // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): a user's projects
    // are "whichever projects this user's resolved TEAM is linked to"
    // (ProjectTeam) - ProjectMember (per-user linking) was retired.
    // Batched: fetch ProjectTeam rows for every resolved team id at once.
    const uniqueTeamIds = Array.from(new Set(resolvedTeamIds.filter((id): id is string => id !== null)));
    const projectTeams =
      uniqueTeamIds.length > 0
        ? await this.client.projectTeam.findMany({
            where: { teamId: { in: uniqueTeamIds } },
            select: { teamId: true, project: { select: { name: true } } },
            orderBy: { project: { name: 'asc' } },
          })
        : [];
    const projectNamesByTeamId = new Map<string, string[]>();
    for (const pt of projectTeams) {
      const list = projectNamesByTeamId.get(pt.teamId) ?? [];
      list.push(pt.project.name);
      projectNamesByTeamId.set(pt.teamId, list);
    }

    return {
      rows: rows.map((r, i) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        role: r.role,
        teamId: resolvedTeamIds[i] ?? null,
        projects: projectNamesByTeamId.get(resolvedTeamIds[i] ?? '') ?? [],
      })),
      total,
    };
  }

  /**
   * GET /api/users/project/:projectId/sales-execs - SALES_EXEC staff linked
   * to a project, for the schedule-visit exec picker.
   *
   * The project→exec link is via lead ownership (Lead.projectId +
   * Lead.ownerId) - there is no direct Project↔Team↔User relation in the
   * schema. Scoping:
   *   - MANAGER: only execs in the manager's own team (resolved via
   *     Team.managerId) who own leads in this project.
   *   - ADMIN/OWNER: all SALES_EXEC who own leads in this project.
   *   - TELECALLER/SALES_EXEC: empty (they can't assign execs).
   */
  async projectSalesExecs(
    actor: JwtPayload,
    projectId: string,
  ): Promise<CreatedUser[]> {
    if (actor.role !== 'ADMIN' && actor.role !== 'OWNER' && actor.role !== 'MANAGER') {
      return [];
    }

    // T-TEAM-AUTHORITATIVE (2026-09-13): resolve EVERY team the manager
    // leads (JWT teamId is unreliable for managers).
    let teamIds: string[] | null = null;
    if (actor.role === 'MANAGER') {
      const teams = await this.client.team.findMany({
        where: { managerId: actor.sub, deletedAt: null },
        select: { id: true },
      });
      teamIds = teams.length > 0 ? teams.map((t) => t.id) : ['__none__'];
    }

    // Distinct owners of this project's leads, optionally team-scoped.
    const owners = await this.client.lead.findMany({
      where: {
        projectId,
        ...(teamIds !== null ? { teamId: { in: teamIds } } : {}),
      },
      select: { ownerId: true },
      distinct: ['ownerId'],
    });
    const ownerIds = owners.map((o) => o.ownerId);

    if (ownerIds.length === 0) return [];

    const execs = await this.client.user.findMany({
      where: {
        id: { in: ownerIds },
        role: 'SALES_EXEC',
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): oldest
        // TeamMember row (SALES_EXEC is never a manager, so no
        // Team.managerId branch needed - see resolveDisplayTeamId).
        teamMemberships: {
          select: { teamId: true },
          orderBy: { assignedAt: 'asc' },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });
    return execs.map((e) => ({
      id: e.id,
      email: e.email,
      name: e.name,
      role: e.role,
      teamId: e.teamMemberships[0]?.teamId ?? null,
    }));
  }

  /**
   * GET /api/users/team - the actor's team + manager, for the chat
   * mention picker. Unlike `list` (staff→self only), this returns the
   * whole team so a telecaller can see + mention their manager and
   * teammates. Scoping:
   *   - OWNER/ADMIN: all users (they can mention anyone).
   *   - MANAGER: their own team (resolved via Team.managerId).
   *   - TELECALLER/SALES_EXEC: their team + the team's manager.
   * Returns the same CreatedUser shape as `list`.
   */
  async teamMembers(actor: JwtPayload): Promise<CreatedUser[]> {
    let where: Record<string, unknown>;
    if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
      where = {};
    } else {
      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): resolve EVERY
      // team the actor is associated with. Managers link via
      // Team.managerId (a manager may lead multiple teams); ordinary
      // staff link via their own TeamMember rows (User.teamId/the JWT
      // teamId claim are gone - a staff member can now be on multiple
      // teams too, so this resolves ALL of them, not just one).
      let teamIds: string[];
      if (actor.role === 'MANAGER') {
        const teams = await this.client.team.findMany({
          where: { managerId: actor.sub, deletedAt: null },
        });
        teamIds = teams.map((t) => t.id);
      } else {
        const memberships = await this.client.teamMember.findMany({
          where: { userId: actor.sub },
          select: { teamId: true },
        });
        teamIds = memberships.map((m) => m.teamId);
      }
      if (teamIds.length === 0) {
        // No team - the actor can only mention themselves.
        return [];
      }
      // Team members + each team's manager (so staff can loop their
      // manager even though the manager isn't a TeamMember row).
      const teams = await this.client.team.findMany({
        where: { id: { in: teamIds } },
        select: { managerId: true },
      });
      const managerIds = Array.from(
        new Set(teams.map((t) => t.managerId).filter((id): id is string => id !== null)),
      );
      where = {
        OR: [
          { teamMemberships: { some: { teamId: { in: teamIds } } } },
          { id: { in: managerIds.length > 0 ? managerIds : ['__none__'] } },
        ],
      };
    }

    const users = await this.client.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        teamMemberships: {
          select: { teamId: true },
          orderBy: { assignedAt: 'asc' },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
    // Managers resolve their display teamId via Team.managerId (see
    // resolveDisplayTeamId); everyone else uses their oldest TeamMember row.
    const managerRows = users.filter((u) => u.role === 'MANAGER');
    const ledTeams =
      managerRows.length > 0
        ? await this.client.team.findMany({
            where: { managerId: { in: managerRows.map((u) => u.id) }, deletedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true, managerId: true },
          })
        : [];
    const ledTeamByManagerId = new Map<string, string>();
    for (const t of ledTeams) {
      if (t.managerId !== null && !ledTeamByManagerId.has(t.managerId)) {
        ledTeamByManagerId.set(t.managerId, t.id);
      }
    }
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      teamId:
        (u.role === 'MANAGER' ? ledTeamByManagerId.get(u.id) : u.teamMemberships[0]?.teamId) ?? null,
    }));
  }
}