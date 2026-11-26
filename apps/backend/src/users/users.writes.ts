// User writes - create, change role, update, delete (Round 67 split).
//
// The permission model is in ./roles; this file only runs it and holds the
// transaction boundary. Every method runs inside ONE withRlsContext so the
// Team/TeamMember reads see the actor's GUCs and the business write commits
// atomically with its AuditLog row (AGENTS.md A2/G-1).

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, rlsContextFrom, withRlsContext } from '@shadhil/database';
import type { PrismaClient, Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { ChangeRoleDto, CreateUserDto, UpdateUserDto } from '@shadhil/api-types';
import { canonicalPhoneOrThrow } from '../common/phone';
import { OWNER, assertCanChangeRole, assertCanCreateRole, isAdminClass, outranks } from './roles';
import { upsertCredentialAccount } from './credentials';
import { UsersBase, rethrowAsUserUniquenessConflict } from './users.support';
import type { CreatedUser, UsersDeps } from './users.support';

export class UsersWrites extends UsersBase {
  async create(actor: JwtPayload, dto: CreateUserDto): Promise<CreatedUser> {
    const actorRole = actor.role;
    const actorIsManager = actorRole === 'MANAGER';
    // Org-owner class: OWNER behaves like ADMIN on this surface
    // (create into any team; auto-team for MANAGER targets).
    const actorIsOrgOwner = actorRole === 'OWNER' || actorRole === 'ADMIN';

    // 1. Role hierarchy gate (fails closed for any staff role).
    assertCanCreateRole(actorRole, dto.role);

    // 1b. Issue #8 slice 2: customerLeadId <-> CUSTOMER is a strict pairing,
    //     and a customer belongs to no team. Shape rules fail before any I/O.
    if (dto.role === 'CUSTOMER') {
      if (dto.customerLeadId === undefined) {
        throw new BadRequestException('customerLeadId is required when creating a CUSTOMER user');
      }
      if (dto.teamId !== undefined) {
        throw new BadRequestException('A CUSTOMER user belongs to no team - omit teamId');
      }
      // 2026-11-18 (user-phone): a buyer's number lives on their LEAD. Storing
      // a second copy here would create two truths for one person and, with the
      // per-org phone index, would make the second login on a jointly-bought
      // flat fail with a 409 (spec D2). Reject rather than silently ignore, so
      // the caller learns the rule instead of believing the write landed.
      if (dto.phone !== undefined && dto.phone !== null) {
        throw new BadRequestException(
          'A CUSTOMER has no phone of their own - update the number on their lead instead',
        );
      }
    } else if (dto.customerLeadId !== undefined) {
      throw new BadRequestException('customerLeadId is only valid for CUSTOMER users');
    }

    // Everything below runs in ONE RLS transaction: the Team reads are
    // FORCE ROW LEVEL SECURITY (unreadable on the bare client), and the
    // user + credential + team + membership + audit writes must all commit
    // or all roll back (replaces the previous manual compensating delete;
    // AGENTS.md A2/G-1). User/Account have no RLS so they behave the same
    // inside the transaction; Team/TeamMember require the actor's GUCs.
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // 2. Resolve the target team.
      let teamId = dto.teamId ?? null;

      if (actorIsManager) {
        // T-TEAM-AUTHORITATIVE (2026-09-13): the manager's team(s) are
        // resolved authoritatively via Team.managerId (a manager may lead
        // multiple teams) - the JWT teamId claim is unreliable. An
        // explicit dto.teamId must be one of THEIR teams; omitted defaults
        // to their first (oldest) managed team.
        const managedTeams = await client.team.findMany({
          where: { managerId: actor.sub, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        });
        if (managedTeams.length === 0) {
          throw new ForbiddenException('You do not manage any team');
        }
        if (dto.teamId !== undefined) {
          if (!managedTeams.some((t) => t.id === dto.teamId)) {
            throw new ForbiddenException('You can only create users in a team you manage');
          }
          teamId = dto.teamId;
        } else {
          teamId = managedTeams[0]!.id;
        }
      } else if (
        actorIsOrgOwner &&
        dto.role !== 'ADMIN' &&
        dto.role !== 'CUSTOMER' &&
        !dto.teamId
      ) {
        // Admin creating a manager WITHOUT teamId: auto-create the team.
        // Admin creating a STAFF user without teamId: reject - ambiguous.
        if (dto.role === 'MANAGER') {
          // Handled post-user-creation (needs the user id).
        } else {
          throw new BadRequestException(
            'teamId is required when an admin creates TELECALLER/SALES_EXEC/ENGINEER users',
          );
        }
      }

      // 3. Reject a stale teamId that doesn't exist, or a soft-deleted one
      //    (pre-FK clarity; deletedAt treated as absent to match the
      //    active-team checks elsewhere).
      if (teamId) {
        const team = await client.team.findUnique({ where: { id: teamId } });
        if (!team || team.deletedAt !== null) {
          throw new NotFoundException(`Team ${teamId} not found`);
        }
      }

      // 3b. The lead a CUSTOMER points at must exist IN THIS ORG. Read under
      //     the actor's context (admin class sees the org's leads); a lead in
      //     another org reads as absent, which is the answer we want.
      if (dto.role === 'CUSTOMER') {
        const lead = await client.lead.findFirst({
          where: { id: dto.customerLeadId, organizationId: actor.organizationId },
          select: { id: true },
        });
        if (lead === null) {
          throw new NotFoundException(`Lead ${dto.customerLeadId} not found`);
        }
      }

      // 4. Create user + credential + (team for new managers) + TeamMember
      //    row + audit row.
      //
      // T-TEAM-AUTHORITATIVE (2026-09-13 clean cutover): User.teamId is gone
      // - TeamMember is the sole membership record now. A TELECALLER/
      // SALES_EXEC (or a MANAGER's own ordinary membership, if ever given
      // one through this path) gets a TeamMember row for `teamId` instead of
      // a scalar column write.
      // T-EMAIL-PER-ORG: the unique constraint is (email, organizationId) -
      // a P2002 here means this email is already taken within THIS org. The
      // phone partial index added 2026-11-18 can also throw P2002, which the
      // mapper attributes by constraint name before choosing the message.
      const created = await client.user
        .create({
          data: {
            email: dto.email,
            name: dto.name,
            role: dto.role,
            emailVerified: false,
            organizationId: actor.organizationId,
            // 2026-11-18 (user-phone): staff contact number. Already normalized
            // by ClearablePhoneSchema. Absent for CUSTOMER (rejected in 1b) and
            // undefined when the caller omitted it, which Prisma writes as NULL.
            ...(dto.role === 'CUSTOMER'
              ? {}
              : { phone: canonicalPhoneOrThrow(dto.phone, dto.phoneCountry) }),
            ...(dto.role === 'CUSTOMER' ? { customerLeadId: dto.customerLeadId } : {}),
            // issue #8 slice 2 (D3): a buyer's login is PROVISIONED by staff
            // with a temporary password that was read out over WhatsApp and
            // typed by somebody else. Spec D3 promises the existing gate
            // forces a rotation on first login, but the column defaults to
            // false and nothing outside the seed's OWNER arm ever set it - so
            // a customer would have sat on `customer_placeholder_pw`
            // indefinitely. Arm it here, for CUSTOMER only: staff roles keep
            // the ungated default chosen in migration 20260915160000.
            //
            // The gate is enforced by JwtAuthGuard (403 PASSWORD_CHANGE_REQUIRED,
            // which the BFF routes to /change-password) and cleared by
            // changePassword() in this same service.
            ...(dto.role === 'CUSTOMER' ? { mustChangePassword: true } : {}),
          },
        })
        .catch(rethrowAsUserUniquenessConflict);

      await upsertCredentialAccount(client, created.id, dto.password);

      // Auto-create the team for a new manager (org-owner creating
      // MANAGER without an explicit teamId). A manager's OWN leadership is
      // Team.managerId, not a TeamMember row - no membership row needed.
      if (dto.role === 'MANAGER' && actorIsOrgOwner && !dto.teamId) {
        const team = await client.team.create({
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
        await client.teamMember.create({
          data: {
            userId: created.id,
            teamId,
            organizationId: actor.organizationId,
            assignedById: actor.sub,
          },
        });
      }

      // Audit row - same transaction; a failure here rolls back the user,
      // so there is never an un-credentialed or unlogged account.
      await client.auditLog.create({
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
            ...(dto.role === 'CUSTOMER' ? { customerLeadId: dto.customerLeadId } : {}),
          },
          reason: `user.create by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: created.id,
        email: created.email,
        name: created.name,
        role: created.role,
        teamId: teamId ?? null,
      };
    });
  }

  async changeRole(
    actor: JwtPayload,
    targetUserId: string,
    dto: ChangeRoleDto,
  ): Promise<CreatedUser> {
    // The Team reads (demotion guard + promotion auto-team) and the
    // resolveDisplayTeamId lookup are FORCE ROW LEVEL SECURITY, so they
    // need the actor's GUCs; the role write and its audit row share one
    // transaction (AGENTS.md A2/G-1).
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // 1. Target must exist IN THIS ORG.
      //
      // T-ORG-EXPLICIT (2026-11-25): this read used to be a bare
      // `findUnique({ id })`. `User` carries NO row-level security, so without
      // this filter an ADMIN in org A could change the role of a user in org B
      // by id alone - and the hierarchy check below cannot catch it, because an
      // ADMIN does outrank a TELECALLER wherever that TELECALLER lives.
      // `update()` got the same fix on 2026-11-18; this is its twin, and the
      // write here is the more dangerous of the two.
      //
      // A cross-org id now reads as absent, which is the answer we want - the
      // same "not found" a genuinely missing row produces.
      const target = await client.user.findFirst({
        where: { id: targetUserId, organizationId: actor.organizationId },
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

      // 3b. Issue #8: a CUSTOMER cannot be minted by a role change - it needs a
      //     lead pointer, which only create() collects. Provision a new
      //     customer account instead.
      if (dto.role === 'CUSTOMER' && target.role !== 'CUSTOMER') {
        throw new BadRequestException(
          'A user cannot be changed into a CUSTOMER - create a customer account with a linked lead instead',
        );
      }

      // 4. Demotion guard: a manager still leading a team cannot be demoted.
      if (target.role === 'MANAGER' && dto.role !== 'MANAGER') {
        const ledTeam = await client.team.findFirst({
          where: { managerId: target.id, deletedAt: null },
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
        const existing = await client.team.findFirst({
          where: { managerId: target.id },
        });
        if (!existing) {
          await client.team.create({
            data: {
              name: `${target.name}'s Team`,
              managerId: target.id,
              organizationId: actor.organizationId,
            },
          });
        }
      }

      const updated = await client.user.update({
        where: { id: target.id },
        // A role change away from CUSTOMER clears the lead pointer in the SAME
        // write (spec): a stale pointer on a staff row would be dead data that
        // the customer helpers must never be trusted to ignore.
        data: {
          role: dto.role,
          ...(target.role === 'CUSTOMER' && dto.role !== 'CUSTOMER'
            ? { customerLeadId: null }
            : {}),
        },
      });
      const teamId = await this.resolveDisplayTeamId(
        client,
        updated.id,
        updated.role,
        actor.organizationId,
      );

      // 6. Audit row in the same transaction (OWNER downcasts to ADMIN at
      //    the RLS layer - rls.ts).
      await client.auditLog.create({
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

      return {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        teamId,
      };
    });
  }

  /**
   * PATCH /api/users/:id - edit a user's name/email/phone (autoplan
   * 2026-09-09; phone 2026-11-18). Hierarchy-gated: the actor must strictly
   * outrank the target (no self-edit, OWNER protected). Mirrors the
   * changeRole guards.
   */
  async update(actor: JwtPayload, targetUserId: string, dto: UpdateUserDto): Promise<CreatedUser> {
    // One RLS transaction: resolveDisplayTeamId reads the FORCE-RLS
    // Team/TeamMember tables, and the user write + audit row must commit
    // atomically (AGENTS.md A2/G-1).
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // 1. Target must exist IN THIS ORG.
      //
      // T-ORG-EXPLICIT (2026-11-18): this read used to be a bare
      // `findUnique({ id })`. `User` carries NO row-level security (verified in
      // the live DB: relrowsecurity = false), so without this filter an ADMIN in
      // org A could edit a user in org B by guessing an id. It also matters more
      // now than it did: the phone index added by this slice is scoped
      // (phone, organizationId), so a cross-tenant caller could otherwise force
      // a 409 inside the victim org's namespace.
      //
      // A cross-org id now reads as absent, which is the answer we want - the
      // same "not found" a genuinely missing row produces.
      const target = await client.user.findFirst({
        where: { id: targetUserId, organizationId: actor.organizationId },
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
        throw new ForbiddenException(`${actor.role} cannot edit a ${target.role} user`);
      }

      // 3b. A CUSTOMER is administrable ONLY by the admin class.
      //
      // The rank table puts CUSTOMER at 1 and MANAGER at 2, so `outranks` above
      // lets a MANAGER through. roles.ts states the rule explicitly ("MANAGER
      // may never touch a CUSTOMER row") and enforces it on create and on role
      // change - but this path did not, so a manager could rename a buyer's
      // account and rewrite their LOGIN EMAIL. Fixed here (2026-11-18).
      if (target.role === 'CUSTOMER' && !isAdminClass(actor.role)) {
        throw new ForbiddenException('Only ADMIN or OWNER can edit a CUSTOMER account');
      }

      // 3c. A CUSTOMER has no phone of their own - it lives on their lead.
      //     Reject rather than silently dropping it, so the caller is told.
      if (target.role === 'CUSTOMER' && dto.phone !== undefined) {
        throw new BadRequestException(
          'A CUSTOMER has no phone of their own - update the number on their lead instead',
        );
      }

      // 4. Apply the update (only the provided fields).
      const data: { name?: string; email?: string; phone?: string | null } = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.email !== undefined) data.email = dto.email;
      // `null` is the erase path (ClearablePhoneSchema); undefined means
      // "omitted", which must leave the stored number untouched.
      if (dto.phone !== undefined) {
        data.phone = canonicalPhoneOrThrow(dto.phone, dto.phoneCountry);
      }

      // T-EMAIL-PER-ORG: a P2002 here means the new email is already taken
      // by someone else within THIS org, OR on the phone index - the error
      // mapper above distinguishes them by constraint name.
      const updated = await client.user
        .update({
          where: { id: target.id },
          data,
        })
        .catch(rethrowAsUserUniquenessConflict);

      // 5. Audit row - same transaction.
      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.update',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: target.id,
          before: { name: target.name, email: target.email, phone: target.phone },
          after: { name: updated.name, email: updated.email, phone: updated.phone },
          reason: `user.update by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        teamId: await this.resolveDisplayTeamId(
          client,
          updated.id,
          updated.role,
          actor.organizationId,
        ),
      };
    });
  }

  /**
   * DELETE /api/users/:id - SOFT delete a user (autoplan 2026-09-09).
   * ADMIN/OWNER only. Sets User.deletedAt (no hard delete): the account row
   * is kept so audit/history survive, but the user cannot sign in and is
   * hidden from every list/picker. No self-delete; OWNER is protected.
   */
  async remove(actor: JwtPayload, targetUserId: string): Promise<{ ok: true }> {
    // 0. Admin/owner only.
    if (!isAdminClass(actor.role)) {
      throw new ForbiddenException('Only ADMIN or OWNER can delete users.');
    }

    // 1. Target must exist IN THIS ORG, not already deleted, and not OWNER.
    //
    // T-ORG-EXPLICIT (2026-11-25): bare `findUnique({ id })` here let an ADMIN
    // in org A soft-delete a user in org B by id. `User` has no RLS, and this
    // method runs on the bare client, so the org term IS the tenant guard.
    const target = await this.client.user.findFirst({
      where: { id: targetUserId, organizationId: actor.organizationId },
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
    await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
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
    });

    return { ok: true };
  }
}
