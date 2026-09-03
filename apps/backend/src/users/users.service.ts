// Users service — the user-creation + role-change model (Rounds 17–21).
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
//     an RLS context — seed.ts precedent).
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
import type { CreateUserDto, ChangeRoleDto } from '@shadhil/api-types';
import { PrismaService } from '../prisma/prisma.module';
import { assertCanCreateRole, assertCanChangeRole, OWNER } from './roles';
import { upsertCredentialAccount } from './credentials';

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  teamId: string | null;
}

@Injectable()
export class UsersService {
  // @Inject with an explicit token — tsx/esbuild does NOT emit
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
      // The manager's team is resolved authoritatively via Team.managerId —
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
      // Admin creating a STAFF user without teamId: reject — ambiguous.
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

      // Audit row — the only write inside an RLS transaction.
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
    //    owner — role changes on self are how orgs get locked out).
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
          `User still leads team "${ledTeam.name}" — move its members or reassign the team before demoting`,
        );
      }
    }

    // 5. Promotion to MANAGER: ensure a team exists (consistent with the
    //    create flow — managers always lead exactly one team).
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
    //    ADMIN there — rls.ts).
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

  async list(actor: JwtPayload): Promise<CreatedUser[]> {
    // Manager scoping resolves TEAM.managerId, same as create() — the JWT
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

    const users = await this.client.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        teamId: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return users;
  }
}