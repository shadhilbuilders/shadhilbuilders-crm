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
import { withRlsContext, type Role, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { CreateUserDto, ChangePasswordDto, ChangeRoleDto, UpdateUserDto, UserFilterDto, UserListResult } from '@shadhil/api-types';
import { PrismaService } from '../prisma/prisma.module';
import { assertCanCreateRole, assertCanChangeRole, outranks, OWNER } from './roles';
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
      // The manager's team is resolved authoritatively via Team.managerId -
      // the JWT teamId claim is unreliable (seeded managers carry
      // teamId=null; the team links through managerId instead).
      const team = await this.client.team.findFirst({
        where: { managerId: actor.sub },
      });
      if (!team) {
        throw new ForbiddenException('You do not manage any team');
      }
      teamId = team.id;
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

    // 4. Create user + credential + (team for new managers) + audit row.
    //    All pre-audit writes on the bare client; audit inside RLS context.
    const created = await this.client.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        role: dto.role,
        teamId: teamId,
        emailVerified: false,
      },
    });

    try {
      await upsertCredentialAccount(this.client, created.id, dto.password);

      // Auto-create the team for a new manager (org-owner creating
      // MANAGER without an explicit teamId).
      if (dto.role === 'MANAGER' && actorIsOrgOwner && !dto.teamId) {
        const team = await this.client.team.create({
          data: {
            name: `${dto.name}'s Team`,
            managerId: created.id,
          },
        });
        await this.client.user.update({
          where: { id: created.id },
          data: { teamId: team.id },
        });
        teamId = team.id;
      }

      // Audit row - the only write inside an RLS transaction.
      await withRlsContext(
        this.client,
        { userId: actor.sub, role: actor.role, teamId: actor.teamId },
        async (tx) => {
          await tx.auditLog.create({
            data: {
              userId: actor.sub,
              action: 'user.create',
              entityType: 'User',
              entityId: created.id,
              after: {
                email: created.email,
                role: created.role,
                teamId: teamId ?? null,
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
    //    create flow - managers always lead exactly one team).
    let teamId: string | null = target.teamId;
    if (dto.role === 'MANAGER' && target.role !== 'MANAGER') {
      const existing = await this.client.team.findFirst({
        where: { managerId: target.id },
      });
      if (!existing) {
        const team = await this.client.team.create({
          data: { name: `${target.name}'s Team`, managerId: target.id },
        });
        teamId = team.id;
      }
    }

    const updated = await this.client.user.update({
      where: { id: target.id },
      data: { role: dto.role, teamId },
    });

    // 6. Audit row in the actor's RLS context (OWNER downcasts to
    //    ADMIN there - rls.ts).
    await withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.changeRole',
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
      teamId: updated.teamId,
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.update',
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
      teamId: updated.teamId,
    };
  }

  /**
   * DELETE /api/users/:id - remove a user (autoplan 2026-09-09).
   * Hierarchy-gated: the actor must strictly outrank the target (no
   * self-delete, OWNER protected). Also deletes the credential Account row
   * so the user can't sign in.
   */
  async remove(
    actor: JwtPayload,
    targetUserId: string,
  ): Promise<{ ok: true }> {
    // 1. Target must exist.
    const target = await this.client.user.findUnique({
      where: { id: targetUserId },
    });
    if (!target) {
      throw new NotFoundException(`User ${targetUserId} not found`);
    }

    // 2. No self-delete.
    if (target.id === actor.sub) {
      throw new ForbiddenException('You cannot delete your own user');
    }

    // 3. Hierarchy: actor must strictly outrank the target. OWNER is
    //    protected (nobody outranks it).
    if (!outranks(actor.role, target.role as Role)) {
      throw new ForbiddenException(
        `${actor.role} cannot delete a ${target.role} user`,
      );
    }

    // 4. Delete the credential Account row (so the user can't sign in),
    //    then the User row. Bare client (auth tables have no RLS).
    await this.client.account.deleteMany({
      where: { accountId: target.id },
    });
    await this.client.user.delete({ where: { id: target.id } });

    // 5. Audit row in the actor's RLS context.
    await withRlsContext(
      this.client,
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.delete',
            entityType: 'User',
            entityId: target.id,
            before: { name: target.name, email: target.email, role: target.role },
            reason: `user.delete by ${actor.email} (${actor.role})`,
          },
        });
      },
    );

    return { ok: true };
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
      { userId: actor.sub, role: actor.role, teamId: actor.teamId },
      async (tx) => {
        await tx.auditLog.create({
          data: {
            userId: actor.sub,
            action: 'user.changePassword',
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
    // Manager scoping resolves TEAM.managerId, same as create() - the JWT
    // teamId claim is unreliable for managers (seed keeps it null).
    // OWNER and ADMIN see all.
    let where: Record<string, unknown>;
    if (actor.role === 'OWNER' || actor.role === 'ADMIN') {
      where = {};
    } else if (actor.role === 'MANAGER') {
      const team = await this.client.team.findFirst({
        where: { managerId: actor.sub },
      });
      where = { teamId: team?.id ?? '__none__' };
    } else {
      where = { id: actor.sub };
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
          teamId: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: filter.offset,
        take: filter.limit,
      }),
      this.client.user.count({ where }),
    ]);
    return { rows, total };
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

    // Resolve the manager's team (JWT teamId is unreliable for managers).
    let teamId: string | null = null;
    if (actor.role === 'MANAGER') {
      const team = await this.client.team.findFirst({
        where: { managerId: actor.sub },
        select: { id: true },
      });
      teamId = team?.id ?? '__none__';
    }

    // Distinct owners of this project's leads, optionally team-scoped.
    const owners = await this.client.lead.findMany({
      where: {
        projectId,
        ...(teamId !== null ? { teamId } : {}),
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
        teamId: true,
      },
      orderBy: { name: 'asc' },
    });
    return execs;
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
      // Resolve the actor's team. Managers link via Team.managerId (JWT
      // teamId is unreliable for them); staff carry teamId on the JWT.
      let teamId: string | null = actor.teamId ?? null;
      if (actor.role === 'MANAGER') {
        const team = await this.client.team.findFirst({
          where: { managerId: actor.sub },
        });
        teamId = team?.id ?? null;
      }
      if (teamId === null) {
        // No team - the actor can only mention themselves.
        return [];
      }
      // Team members + the team's manager (so staff can loop their
      // manager even though the manager isn't a teamId member).
      const team = await this.client.team.findUnique({
        where: { id: teamId },
        select: { managerId: true },
      });
      where = {
        OR: [{ teamId }, { id: team?.managerId ?? '__none__' }],
      };
    }

    const users = await this.client.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        teamId: true,
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
    return users;
  }
}