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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateProjectDtoSchema,
  UpdateProjectDtoSchema,
  type CreateProjectDto,
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

// Project id format: cuids from the app AND readable seed ids
// (`seed-project-metro-heights`) are both valid - same convention as the
// LeadFilterDto projectId (min(1).max(64), auth.ts teamId precedent).
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
      'List every project (project registry for the sidebar switcher). All roles.',
  })
  async list(@Req() req: AuthedRequest): Promise<ProjectListResult> {
    return this.projects.list(req.user!);
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
}