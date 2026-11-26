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
// Write paths (T-TEAM-AUTHORITATIVE, 2026-09-13): every method here runs
// inside ONE withRlsContext transaction so the Team/TeamMember reads are
// subject to the actor's GUCs (both tables are FORCE ROW LEVEL SECURITY -
// on the bare client they read as empty) and the business write commits
// atomically with its AuditLog row (AGENTS.md A2/G-1).
//   - User/Account: no RLS, so they behave identically inside the tx.
//   - Team/TeamMember/AuditLog: RLS-enforced; the actor's context is what
//     makes them readable and writable at all.
//   - OWNER travels as ADMIN at the RLS layer (downcast in rls.ts).

// ─────────────────────────────────────────────────────────────────────────────
// Round 67 (2026-11-26): this class is a FACADE. The six concerns moved into
// their own files, one per question a caller has:
//
//   ./users.login-lookup        resolveLoginIdentifier (public, no JWT)
//   ./users.writes              create, changeRole, update, remove
//   ./users.profile             updateSelf, changePassword
//   ./users.manager             assignManager
//   ./users.directory.detail    getUser
//   ./users.directory.list      list
//   ./users.directory.scoped    projectSalesExecs, teamMembers
//   ./users.support             types, the uniqueness-error mapping, UsersBase
//
// The methods below are one-line delegations and nothing else: no branch, no
// query, no rule. That is the point - a reader who wants behaviour opens the
// concern, and the facade exists only so the controller, the module and the
// existing tests keep the same name to call.
//
// The concerns are constructed HERE rather than injected, so UsersService's
// constructor signature, the Nest module's provider list, and every
// `new UsersService(prisma)` in the unit tests are unchanged.
// ─────────────────────────────────────────────────────────────────────────────
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.module';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';
import type { StorageProvider } from '../storage/storage.provider';

import type { JwtPayload } from '@shadhil/auth';
import type {
  AssignManagerDto,
  ChangePasswordDto,
  ChangeRoleDto,
  CreateUserDto,
  LoginIdentifierDto,
  LoginIdentifierResult,
  UpdateProfileDto,
  UpdateUserDto,
  UserDetail,
  UserFilterDto,
  UserListResult,
} from '@shadhil/api-types';
import type { CreatedUser, UpdatedProfile } from './users.support';
import type { UsersDeps } from './users.support';
import { UsersDirectoryDetail } from './users.directory.detail';
import { UsersDirectoryList } from './users.directory.list';
import { UsersDirectoryScoped } from './users.directory.scoped';
import { UsersLoginLookup } from './users.login-lookup';
import { UsersManager } from './users.manager';
import { UsersProfile } from './users.profile';
import { UsersWrites } from './users.writes';

// Re-exported from where the tests and the rest of the backend already import
// them, so the split did not move a public name.
export { searchPhoneTerms, uniqueIndexFromAdapterCause } from './users.support';
export type { CreatedUser, UpdatedProfile } from './users.support';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  private readonly loginLookup: UsersLoginLookup;
  private readonly writes: UsersWrites;
  private readonly profile: UsersProfile;
  private readonly manager: UsersManager;
  private readonly detail: UsersDirectoryDetail;
  private readonly listView: UsersDirectoryList;
  private readonly scoped: UsersDirectoryScoped;

  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime. PrismaService is exported from prisma.module.ts.
  constructor(
    @Inject(PrismaService) prismaService: PrismaService,
    /**
     * StorageModule is @Global and exports this token, so the app always
     * supplies it. Optional ONLY so the two dozen unit tests that construct
     * `new UsersService(prisma)` without a storage double keep compiling.
     *
     * A missing provider fails CLOSED instead of silently skipping the check:
     * `assertAvatarKey` refuses any photo key when it is absent, so a
     * misconfigured module cannot become an unvalidated write path.
     */
    @Optional()
    @Inject(STORAGE_PROVIDER)
    storage?: StorageProvider,
  ) {
    const deps: UsersDeps = {
      client: prismaService.$client,
      logger: this.logger,
      storage,
    };
    this.loginLookup = new UsersLoginLookup(deps);
    this.writes = new UsersWrites(deps);
    this.profile = new UsersProfile(deps);
    this.manager = new UsersManager(deps);
    this.detail = new UsersDirectoryDetail(deps);
    this.listView = new UsersDirectoryList(deps);
    this.scoped = new UsersDirectoryScoped(deps);
  }

  async resolveLoginIdentifier(dto: LoginIdentifierDto): Promise<LoginIdentifierResult> {
    return this.loginLookup.resolveLoginIdentifier(dto);
  }

  async create(actor: JwtPayload, dto: CreateUserDto): Promise<CreatedUser> {
    return this.writes.create(actor, dto);
  }

  async changeRole(
    actor: JwtPayload,
    targetUserId: string,
    dto: ChangeRoleDto,
  ): Promise<CreatedUser> {
    return this.writes.changeRole(actor, targetUserId, dto);
  }

  async update(actor: JwtPayload, targetUserId: string, dto: UpdateUserDto): Promise<CreatedUser> {
    return this.writes.update(actor, targetUserId, dto);
  }

  async remove(actor: JwtPayload, targetUserId: string): Promise<{ ok: true }> {
    return this.writes.remove(actor, targetUserId);
  }

  async updateSelf(actor: JwtPayload, dto: UpdateProfileDto): Promise<UpdatedProfile> {
    return this.profile.updateSelf(actor, dto);
  }

  async changePassword(
    actor: JwtPayload,
    targetUserId: string,
    dto: ChangePasswordDto,
  ): Promise<{ ok: true; mustChangePassword: false }> {
    return this.profile.changePassword(actor, targetUserId, dto);
  }

  async assignManager(
    actor: JwtPayload,
    targetUserId: string,
    dto: AssignManagerDto,
  ): Promise<CreatedUser> {
    return this.manager.assignManager(actor, targetUserId, dto);
  }

  async getUser(actor: JwtPayload, targetUserId: string): Promise<UserDetail> {
    return this.detail.getUser(actor, targetUserId);
  }

  async list(
    actor: JwtPayload,
    filter: UserFilterDto = { limit: 50, offset: 0 },
  ): Promise<UserListResult> {
    return this.listView.list(actor, filter);
  }

  async projectSalesExecs(actor: JwtPayload, projectId: string): Promise<CreatedUser[]> {
    return this.scoped.projectSalesExecs(actor, projectId);
  }

  async teamMembers(actor: JwtPayload, projectId?: string): Promise<CreatedUser[]> {
    return this.scoped.teamMembers(actor, projectId);
  }
}
