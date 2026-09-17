// Users controller - role-guarded user-creation surface (Rounds 17/18).
// All routes JWT-protected via the global guard; hierarchy enforced in the
// service (assertCanCreateRole + team checks). The AuditLog insert runs in
// the ACTOR's own RLS context so the policy's app.user_id check passes.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AssignManagerDtoSchema,
  ChangePasswordDtoSchema,
  ChangeRoleDtoSchema,
  CreateUserDtoSchema,
  UpdateUserDtoSchema,
  UserFilterDtoSchema,
  type AssignManagerDto,
  type ChangePasswordDto,
  type ChangeRoleDto,
  type CreateUserDto,
  type UpdateUserDto,
  type UserDetail,
  type UserFilterDto,
  type UserListResult,
} from '@shadhil/api-types';
import { z } from 'zod';
import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { UsersService, type CreatedUser } from './users.service';

/**
 * Parse a request body with a shared Zod schema; a ZodError becomes a 400
 * (not a 500 - the ValidationPipe doesn't handle raw Zod schemas).
 */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    );
  }
  return result.data;
}

/**
 * Parse query-string filters into the UserFilterDto. `role` may repeat
 * (e.g. `?role=SALES_EXEC&role=TELECALLER`) - coerce to an array.
 * `limit`/`offset` drive server-side pagination.
 */
function parseFilter(query: Record<string, unknown>): UserFilterDto {
  const roleRaw = query['role'];
  let role: string | string[] | undefined;
  if (typeof roleRaw === 'string') {
    // The frontend joins multi-select roles with a comma
    // (`role=SALES_EXEC,TELECALLER`). Split before schema validation - a
    // literal "SALES_EXEC,TELECALLER" is not a valid single Role enum value.
    const parts = roleRaw.split(',').map((s) => s.trim()).filter(Boolean);
    role = parts.length > 1 ? parts : parts[0];
    if (parts.length === 0) role = undefined;
  } else if (Array.isArray(roleRaw)) {
    role = roleRaw.filter((v): v is string => typeof v === 'string');
  }
  const result = UserFilterDtoSchema.safeParse({
    role,
    search: typeof query['search'] === 'string' ? query['search'] : undefined,
    projectId:
      typeof query['projectId'] === 'string' && query['projectId'].length > 0
        ? query['projectId']
        : undefined,
    limit:
      typeof query['limit'] === 'string'
        ? Number.parseInt(query['limit'], 10)
        : undefined,
    offset:
      typeof query['offset'] === 'string'
        ? Number.parseInt(query['offset'], 10)
        : undefined,
  });
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

@ApiTags('users')
@ApiBearerAuth('jwt')
@Controller('users')
export class UsersController {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at
  // runtime (same reason app.module.ts uses useFactory + inject).
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a user (OWNER/ADMIN: below their role; MANAGER: staff in own team)',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<CreatedUser> {
    // Shared Zod schema validates BEFORE the service is touched (the
    // api-types convention: same schema rejects at BFF too).
    const dto: CreateUserDto = parseBody(CreateUserDtoSchema, body);
    return this.users.create(req.user!, dto);
  }

  @Patch(':id/role')
  @ApiOperation({
    summary:
      'Change a user role (OWNER: anyone; ADMIN: below; MANAGER: staff in team). Guards: no self-changes, OWNER unassignable, team-leading managers must be unlinked first.',
  })
  async changeRole(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CreatedUser> {
    const dto: ChangeRoleDto = parseBody(ChangeRoleDtoSchema, body);
    return this.users.changeRole(req.user!, id, dto);
  }

  @Patch(':id/manager')
  @ApiOperation({
    summary:
      "Assign/reassign a TELECALLER/SALES_EXEC's manager (autoplan 2026-09-13) by moving them into the manager's team. OWNER/ADMIN: any led team; MANAGER: own team only.",
  })
  async assignManager(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CreatedUser> {
    const dto: AssignManagerDto = parseBody(AssignManagerDtoSchema, body);
    return this.users.assignManager(req.user!, id, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Edit a user name/email (autoplan 2026-09-09). Hierarchy-gated: actor must strictly outrank the target; no self-edit; OWNER protected.',
  })
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CreatedUser> {
    const dto: UpdateUserDto = parseBody(UpdateUserDtoSchema, body);
    return this.users.update(req.user!, id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Delete a user (autoplan 2026-09-09). Hierarchy-gated: actor must strictly outrank the target; no self-delete; OWNER protected. Also removes the credential Account row.',
  })
  async remove(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    return this.users.remove(req.user!, id);
  }

  /**
   * T-S hardening (2026-09-04, Week 5):
   * POST /api/users/:id/change-password
   *
   * Self-service password rotation + admin reset. The actor must be
   * the target user themselves OR ADMIN/OWNER (enforced in the
   * service). On success, User.mustChangePassword flips to false and
   * the JwtAuthGuard stops returning PASSWORD_CHANGE_REQUIRED.
   */
  @Post(':id/change-password')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Change a user password (self or admin/owner). Verifies the old password, hashes the new with the seed scrypt params, flips User.mustChangePassword=false.',
  })
  async changePassword(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ ok: true; mustChangePassword: false }> {
    const dto: ChangePasswordDto = parseBody(ChangePasswordDtoSchema, body);
    return this.users.changePassword(req.user!, id, dto);
  }

  @Get()
  @ApiOperation({
    summary:
      'List users (ADMIN: all; MANAGER: own team; staff: self). Optional ?role= / ?search= / ?projectId= filters + server pagination. ?projectId= narrows to that project staff (intersection - never widens the caller\'s scope).',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<UserListResult> {
    return this.users.list(req.user!, parseFilter(query));
  }

  /**
   * GET /api/users/team - the actor's team + manager, for the chat
   * mention picker. Unlike `list` (staff→self only), this returns the
   * whole team so a telecaller can see + mention their manager and
   * teammates. Route order matters: `team` must be declared BEFORE
   * `:id/...` routes so it isn't captured as an id.
   *
   * T-USER-PROJECT-SCOPE (2026-09-16): accepts an optional ?projectId=. The
   * chat @mention picker passes the ACTIVE project, so an ADMIN/OWNER (who
   * otherwise sees every user in the org) is offered that project's staff
   * rather than the whole directory.
   */
  @Get('team')
  @ApiOperation({
    summary:
      'List the actor team + manager (mention picker). ADMIN/OWNER: all; MANAGER: own team; staff: team + manager. Optional ?projectId= narrows ADMIN/OWNER to that project staff.',
  })
  async team(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<CreatedUser[]> {
    const projectId =
      typeof query['projectId'] === 'string' && query['projectId'].length > 0
        ? query['projectId']
        : undefined;
    return this.users.teamMembers(req.user!, projectId);
  }

  /**
   * GET /api/users/project/:projectId/sales-execs - SALES_EXEC staff linked
   * to a project, for the schedule-visit exec picker. Route order matters:
   * declared before `:id/...` routes so it isn't captured as an id.
   */
  @Get('project/:projectId/sales-execs')
  @ApiOperation({
    summary:
      'List SALES_EXEC staff linked to a project (MANAGER: own team; ADMIN/OWNER: all project execs).',
  })
  async projectSalesExecs(
    @Req() req: AuthedRequest,
    @Param('projectId') projectId: string,
  ): Promise<CreatedUser[]> {
    return this.users.projectSalesExecs(req.user!, projectId);
  }

  /**
   * GET /api/users/:id - the user detail page (autoplan 2026-09-13).
   * Declared LAST so it doesn't shadow the more specific routes above
   * (`team`, `project/:projectId/sales-execs`) - Nest matches routes in
   * declaration order and `:id` would otherwise capture `team` as an id.
   */
  @Get(':id')
  @ApiOperation({
    summary:
      'Get a user (detail page). ADMIN/OWNER: anyone; MANAGER: own team + self; staff: self only. Includes team, manager (staff roles only), and project assignments.',
  })
  async getOne(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<UserDetail> {
    return this.users.getUser(req.user!, id);
  }
}