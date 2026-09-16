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
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateProjectDtoSchema,
  ProjectFilterDtoSchema,
  UpdateProjectDtoSchema,
  type CreateProjectDto,
  type ProjectFilterDto,
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
// DTO pin it to z.cuid2(); validate strictly here too so a non-cuid2 id
// (e.g. `fixture-project-a`) is rejected rather than silently accepted.
const ID_RE = z.cuid2();

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

  @Get('by-slug/:slug')
  @ApiOperation({
    summary:
      'Resolve a project by slug within the actor\'s org (for the ' +
      '[projectSlug] URL segment). Returns the project id + slug so the ' +
      'page can key id-based hooks/APIs.',
  })
  async bySlug(
    @Req() req: AuthedRequest,
    @Param('slug') slug: string,
  ): Promise<{ id: string; slug: string; name: string }> {
    const project = await this.projects.findBySlug(req.user!, slug);
    if (project === null) {
      throw new NotFoundException(
        'Project not found in your organization or not accessible',
      );
    }
    return project;
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
    if (!ID_RE.safeParse(id).success) {
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
    if (!ID_RE.safeParse(id).success) {
      throw new BadRequestException(`Invalid project id: ${id}`);
    }
    return this.projects.remove(req.user!, id);
  }
}