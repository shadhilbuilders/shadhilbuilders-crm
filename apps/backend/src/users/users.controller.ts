// Users controller — role-guarded user-creation surface (Rounds 17/18).
// All routes JWT-protected via the global guard; hierarchy enforced in the
// service (assertCanCreateRole + team checks). The AuditLog insert runs in
// the ACTOR's own RLS context so the policy's app.user_id check passes.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ChangePasswordDtoSchema,
  ChangeRoleDtoSchema,
  CreateUserDtoSchema,
  type ChangePasswordDto,
  type ChangeRoleDto,
  type CreateUserDto,
} from '@shadhil/api-types';
import { z } from 'zod';
import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { UsersService, type CreatedUser } from './users.service';

/**
 * Parse a request body with a shared Zod schema; a ZodError becomes a 400
 * (not a 500 — the ValidationPipe doesn't handle raw Zod schemas).
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

@ApiTags('users')
@ApiBearerAuth('jwt')
@Controller('users')
export class UsersController {
  // @Inject with an explicit token — tsx/esbuild does NOT emit
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
    const dto: CreateUserDto = CreateUserDtoSchema.parse(body);
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
    const dto: ChangeRoleDto = ChangeRoleDtoSchema.parse(body);
    return this.users.changeRole(req.user!, id, dto);
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
    const dto: ChangePasswordDto = ChangePasswordDtoSchema.parse(body);
    return this.users.changePassword(req.user!, id, dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List users (ADMIN: all; MANAGER: own team; staff: self)',
  })
  async list(@Req() req: AuthedRequest): Promise<CreatedUser[]> {
    return this.users.list(req.user!);
  }
}