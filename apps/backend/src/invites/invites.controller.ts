// Invites controller - admin surface (2026-11-20).
//
// All routes JWT-guarded by the global JwtAuthGuard; hierarchy enforced in
// the service (assertCanCreateRole for create, loadManageable for
// resend/revoke). Route ORDER is not load-bearing here (every path segment is
// a literal except the trailing `:id`, and those are all distinct verbs), but
// the create/list pair is kept first to mirror the resource's mental model.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateInviteDtoSchema,
  InviteFilterDtoSchema,
  type CreateInviteDto,
  type CreateInviteResult,
  type InviteFilterDto,
  type InviteListResult,
  type InviteRow,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';

import { InvitesService } from './invites.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
    );
  }
  return result.data;
}

@ApiTags('invites')
@ApiBearerAuth('jwt')
@Controller('invites')
export class InvitesController {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes, so bare constructor params arrive undefined at runtime.
  constructor(@Inject(InvitesService) private readonly invites: InvitesService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a staff invite (OWNER/ADMIN: below their role; MANAGER: staff in own team). ' +
      'Returns the one-time link plus the WhatsApp deep link. The raw token is never stored.',
  })
  async create(@Req() req: AuthedRequest, @Body() body: unknown): Promise<CreateInviteResult> {
    const dto: CreateInviteDto = parseBody(CreateInviteDtoSchema, body);
    return this.invites.create(req.user!, dto);
  }

  @Get()
  @ApiOperation({
    summary:
      'List invites (ADMIN/OWNER: whole org; MANAGER: teams they lead). Optional ?status= ' +
      'filter, applied in SQL - EXPIRED is derived from the deadline, so it is not a column match.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<InviteListResult> {
    const parsed = InviteFilterDtoSchema.safeParse({
      status: typeof query['status'] === 'string' ? query['status'] : undefined,
      limit: typeof query['limit'] === 'string' ? Number.parseInt(query['limit'], 10) : undefined,
      offset: typeof query['offset'] === 'string' ? Number.parseInt(query['offset'], 10) : undefined,
    });
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`),
      );
    }
    const filter: InviteFilterDto = parsed.data;
    return this.invites.list(req.user!, filter);
  }

  @Post(':id/resend')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Rotate an invite token and extend its expiry. The old link dies immediately. ' +
      'Rejected for an accepted invite.',
  })
  async resend(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<CreateInviteResult> {
    return this.invites.resend(req.user!, id);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Revoke an invite. The link stops working immediately. Idempotent; ' +
      'rejected for an accepted invite (the account exists - remove the user instead).',
  })
  async revoke(@Req() req: AuthedRequest, @Param('id') id: string): Promise<InviteRow> {
    return this.invites.revoke(req.user!, id);
  }
}
