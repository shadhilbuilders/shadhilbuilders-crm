// Projects controller - JWT-protected CRUD on the project registry.
//
// Mirrors the teams/ and leads/ controller patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit
//     design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//   - Role guards live in the SERVICE (403/404/409 semantics), not as
//     per-route Nest guards, mirroring the leads convention where the
//     global JwtAuthGuard handles authentication only.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateProjectDtoSchema,
  LinkProjectMemberDtoSchema,
  ProjectFilterDtoSchema,
  UpdateProjectDtoSchema,
  type CreateProjectDto,
  type LinkProjectMemberDto,
  type ProjectFilterDto,
  type ProjectMemberRow,
  type UpdateProjectDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import {
  ProjectsService,
  type ProjectListResult,
  type ProjectRow,
} from './projects.service';

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'body'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

/**
 * Parse query-string filters into a ProjectFilterDto. `search` (name/slug
 * match), `limit`/`offset` (server-side pagination) are all optional — when
 * omitted the service returns the full registry (the sidebar switcher's
 * useProjects calls with no params).
 */
function parseFilter(query: Record<string, unknown>): ProjectFilterDto {
  const limit =
    typeof query['limit'] === 'string'
      ? Number.parseInt(query['limit'], 10)
      : undefined;
  const offset =
    typeof query['offset'] === 'string'
      ? Number.parseInt(query['offset'], 10)
      : undefined;
  const result = ProjectFilterDtoSchema.safeParse({
    search: typeof query['search'] === 'string' ? query['search'] : undefined,
    limit,
    offset,
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

// Project id format: real cuid2 (T-PROJID-CUID2, 2026-09-08) - the same
// shape the app generates at runtime. The [projectId] URL segment and every
// DTO pin it to z.cuid2().
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

@ApiTags('projects')
@ApiBearerAuth('jwt')
@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(ProjectsService) private readonly projects: ProjectsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List projects (registry for the switcher, all roles). Optional ' +
      '?search= & ?limit=&offset= for server-side search/pagination.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<ProjectListResult> {
    return this.projects.list(req.user!, parseFilter(query));
  }

  @Post()
  @ApiOperation({
    summary: 'Create a project. ADMIN/OWNER only. Slug derived from name.',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<ProjectRow> {
    const dto: CreateProjectDto = parseBody(CreateProjectDtoSchema, body);
    return this.projects.create(req.user!, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Update a project (name / address / RERA / CMDA). ADMIN/OWNER only. Slug immutable.',
  })
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProjectRow> {
    if (!ID_RE.test(id)) {
      throw new BadRequestException(`Invalid project id: ${id}`);
    }
    const dto: UpdateProjectDto = parseBody(UpdateProjectDtoSchema, body);
    return this.projects.update(req.user!, id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Delete a project. OWNER only. 409 when bookings exist under its units.',
  })
  async remove(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    if (!ID_RE.test(id)) {
      throw new BadRequestException(`Invalid project id: ${id}`);
    }
    return this.projects.remove(req.user!, id);
  }

  @Get(':id/members')
  @ApiOperation({
    summary:
      'List a project staff (explicit ProjectMember UNION lead-owners). All authenticated roles.',
  })
  async listMembers(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<ProjectMemberRow[]> {
    if (!ID_RE.test(id)) {
      throw new BadRequestException(`Invalid project id: ${id}`);
    }
    return this.projects.listMembers(req.user!, id);
  }

  @Post(':id/members')
  @ApiOperation({
    summary:
      'Link an existing user to a project. ADMIN/OWNER only. Idempotent (upsert).',
  })
  async addMember(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ProjectMemberRow> {
    if (!ID_RE.test(id)) {
      throw new BadRequestException(`Invalid project id: ${id}`);
    }
    const dto: LinkProjectMemberDto = parseBody(
      LinkProjectMemberDtoSchema,
      body,
    );
    return this.projects.addMember(req.user!, id, dto);
  }

  @Delete(':id/members/:userId')
  @ApiOperation({
    summary:
      'Unlink a user from a project. MANAGER/ADMIN/OWNER only. Removes the explicit membership.',
  })
  async unlinkMember(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<{ ok: true }> {
    if (!ID_RE.test(id) || !ID_RE.test(userId)) {
      throw new BadRequestException(`Invalid id: ${id}/${userId}`);
    }
    return this.projects.unlinkMember(req.user!, id, userId);
  }
}