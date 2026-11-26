// The signed-in user editing themselves - profile and password (Round 67
// split).
//
// Deliberately narrower than the write path: no role, no team, no target id
// from the client. The avatar checks fail CLOSED when storage is unconfigured.

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { rlsContextFrom, withRlsContext } from '@shadhil/database';
import type { PrismaClient, Role } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import { isPlaceholderEmail } from '@shadhil/api-types';
import type { ChangePasswordDto, UpdateProfileDto } from '@shadhil/api-types';
import { canonicalPhoneOrThrow } from '../common/phone';
import { OWNER, outranks } from './roles';
import { hashPassword, verifyPassword, verifyPasswordAsync } from './credentials';
import { UsersBase, rethrowAsUserUniquenessConflict } from './users.support';
import type { UpdatedProfile, UsersDeps } from './users.support';

export class UsersProfile extends UsersBase {
  /**
   * PATCH /api/users/me - SELF-service profile edit (settings page, 2026-09-18).
   *
   * The one profile write a user may perform on themselves. Distinct from
   * `update()` above, which is the ADMIN surface and deliberately REFUSES
   * self-edits ("self-profile editing is a separate surface").
   *
   * Authorization is by CONSTRUCTION, not by a role check: the target id comes
   * from the verified JWT `sub` and the route takes no id parameter, so there
   * is no id a caller could supply to reach someone else's row. The write is
   * additionally pinned to `actor.sub` in the `where` clause rather than
   * trusting the earlier read (a TOCTOU-safe shape).
   *
   * Fields: `name` only. Email is excluded because this deployment has no
   * email-verification flow - see UpdateProfileDtoSchema's comment.
   *
   * RLS note: `User` carries NO row-level security (verified in the live DB:
   * relrowsecurity = false), so - like `changePassword` - the row scope here
   * is the code above, not a policy. The AuditLog row still runs inside the
   * actor's RLS context, because THAT table is FORCE RLS and the insert policy
   * gates on app.user_id.
   */
  async updateSelf(actor: JwtPayload, dto: UpdateProfileDto): Promise<UpdatedProfile> {
    // 1. Read the current value first so the audit row can carry a real
    //    before/after pair (and so a no-op change can be reported as such).
    const before = await this.client.user.findUnique({
      where: { id: actor.sub },
      select: { id: true, name: true, email: true, role: true, phone: true, avatarKey: true },
    });
    if (before === null) {
      // The JWT is valid but the row is gone (hard-deleted account). Fail
      // loudly rather than silently succeeding on nothing.
      throw new NotFoundException(`User ${actor.sub} not found`);
    }

    // 1b. A CUSTOMER has no phone of their own (2026-11-18). The DTO has no
    //     role to inspect, so the rule lives here: their number belongs to the
    //     lead, which is the WhatsApp identity key. Silently dropping the field
    //     would tell a buyer their number saved when nothing changed.
    if (before.role === 'CUSTOMER' && dto.phone !== undefined) {
      throw new BadRequestException(
        'Your account has no phone of its own - contact the project office to update your number',
      );
    }

    // 1c. Email self-service (2026-11-21), narrow on purpose.
    //
    // A user may REPLACE a generated `noemail+<hex>@users.invalid` address with
    // a real one. They may NOT move from one real address to another: this
    // deployment has no email verification, so that would repoint the login at a
    // mailbox nobody has proven they own. Real-to-real stays with ADMIN/OWNER
    // through PATCH /api/users/:id.
    if (dto.email !== undefined) {
      if (!isPlaceholderEmail(before.email)) {
        throw new BadRequestException(
          'Your email is already set. Ask an administrator to change it.',
        );
      }
      if (dto.currentPassword === undefined) {
        // The DTO already requires it; this is the belt-and-braces check for a
        // caller that bypasses validation.
        throw new BadRequestException('Enter your current password to change your email address');
      }
      const credential = await this.client.account.findFirst({
        where: { userId: actor.sub, providerId: 'credential', issuer: 'local:credential' },
        select: { password: true },
      });
      const correct = await verifyPasswordAsync(dto.currentPassword, credential?.password ?? null);
      if (!correct) {
        throw new BadRequestException('That password is not correct.');
      }
    }

    // 1d. An account must keep ONE usable login identifier. Clearing the phone
    //     while the address is still a placeholder would leave nothing the
    //     person can sign in with, and the synthetic address is never shown
    //     to them.
    const clearingPhone = dto.phone === null;
    const emailStaysPlaceholder = dto.email === undefined && isPlaceholderEmail(before.email);
    if (clearingPhone && emailStaysPlaceholder) {
      throw new BadRequestException(
        'Add an email address before removing your phone number - otherwise you could not sign in.',
      );
    }

    // 1e. A photo key is not trusted because it parsed as a string (2026-11-24).
    //     Two checks run before it can reach the row: the key must sit in the
    //     caller's own org namespace (otherwise a tenant could point at another
    //     tenant's object), and the STORED bytes must be an image. The upload
    //     route records the type from the bytes, but it falls back to the
    //     client's declaration for formats it cannot identify, so a stat is the
    //     only honest check. Clearing the photo (null) skips both.
    if (typeof dto.avatarKey === 'string') {
      await this.assertAvatarKey(actor, dto.avatarKey);
    }

    // 2. Write + audit atomically: the audit row must not survive a failed
    //    write, and the write must not land unaudited (AGENTS.md A2/G-1).
    //    One RLS transaction (AuditLog is FORCE RLS; User is not, but sharing
    //    the tx keeps the pair atomic).
    const saved = await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      const client = tx as unknown as PrismaClient;

      // Only the provided fields. `phone: null` is the erase path; undefined
      // means the caller did not touch it. The DTO's refinement guarantees at
      // least one field is present, so this is never an empty write.
      const data: {
        name?: string;
        phone?: string | null;
        email?: string;
        emailVerified?: boolean;
        avatarKey?: string | null;
      } = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.phone !== undefined) {
        data.phone = canonicalPhoneOrThrow(dto.phone, dto.phoneCountry);
      }
      if (dto.email !== undefined) {
        data.email = dto.email;
        // Nothing has proven the new address yet, so it is stored unverified.
        // The moment a mailer exists, the reset path must be gated on this.
        data.emailVerified = false;
      }
      // `null` clears the photo; undefined means the caller did not touch it.
      if (dto.avatarKey !== undefined) data.avatarKey = dto.avatarKey;

      const updated = await client.user
        .update({
          where: { id: actor.sub },
          data,
          select: { id: true, name: true, email: true, role: true, phone: true, avatarKey: true },
        })
        .catch(rethrowAsUserUniquenessConflict);

      await client.auditLog.create({
        data: {
          userId: actor.sub,
          action: 'user.updateSelf',
          organizationId: actor.organizationId,
          entityType: 'User',
          entityId: actor.sub,
          before: {
            name: before.name,
            phone: before.phone,
            email: before.email,
            avatarKey: before.avatarKey,
          },
          after: {
            name: updated.name,
            phone: updated.phone,
            email: updated.email,
            avatarKey: updated.avatarKey,
          },
          reason: `profile updated by ${actor.email} (${actor.role})`,
        },
      });

      return {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        phone: updated.phone,
        avatarKey: updated.avatarKey,
        imageUrl: this.avatarUrl(updated.avatarKey),
      };
    });

    // 3. Drop the replaced blob AFTER the row has committed, and never fail the
    //    save on it: a stale object is a storage bill, a failed save is a user
    //    who believes their photo did not save. Deleting before the write would
    //    lose the old photo whenever the row write failed.
    if (before.avatarKey !== null && before.avatarKey !== saved.avatarKey) {
      await this.deleteAvatarBlob(before.avatarKey);
    }

    return saved;
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
    // 1. Target must exist IN THIS ORG.
    //
    // T-ORG-EXPLICIT (2026-11-25): this is the worst of the family. A bare
    // `findUnique({ id })` let an ADMIN in org A reset the password of a user in
    // org B, which is an account takeover across tenants - the admin-reset branch
    // below only requires that the actor outrank the target, and an ADMIN
    // outranks a TELECALLER in any org. `User` has no RLS to stop it.
    const target = await this.client.user.findFirst({
      where: { id: targetUserId, organizationId: actor.organizationId },
      select: { id: true, email: true, role: true, mustChangePassword: true },
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
    // Admin reset: the actor must strictly outrank the target (an ADMIN
    // can't reset the OWNER or another ADMIN), mirroring the role-change
    // hierarchy guard.
    if (!isSelf && !outranks(actor.role, target.role)) {
      throw new ForbiddenException(`You can't reset the password of a ${target.role} user`);
    }
    // Self-service rotation must prove knowledge of the current password.
    // An admin reset of ANOTHER user does not (the admin doesn't know it).
    if (isSelf && (dto.oldPassword === undefined || dto.oldPassword === '')) {
      throw new BadRequestException('Current password is required');
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
    if (account === null) {
      throw new BadRequestException('Current password is incorrect');
    }
    if (isSelf && !verifyPassword(dto.oldPassword as string, account.password)) {
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
    await withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
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
    });

    return { ok: true, mustChangePassword: false };
  }
}
