// Leads controller - list/create/update/transition surface.
//
// All routes JWT-protected via the global JwtAuthGuard; this controller
// does NOT add per-route guards. The service enforces:
//   - Role lane (TELECALLER/SALES_EXEC only own leads; MANAGER sees team;
//     ADMIN/OWNER sees everything).
//   - State-machine guard on PATCH /leads/:id/transition.
//   - Phone uniqueness on create.
//
// DTO validation happens HERE (controller), not via NestJS ValidationPipe -
// the api-types convention is shared Zod schemas that BOTH the NestJS
// controller and the Next.js BFF route handler parse with. Keeps the
// wire contract in one place.
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
  CreateLeadDtoSchema,
  LeadFilterDtoSchema,
  LeadStateTransitionDtoSchema,
  ReassignLeadDtoSchema,
  UpdateLeadDtoSchema,
  type CreateLeadDto,
  type LeadActivity,
  type LeadDetail,
  type LeadFilterDto,
  type LeadStateTransitionDto,
  type ReassignLeadDto,
  type UpdateLeadDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { LeadsService, type LeadListResult, type LeadRow } from './leads.service';

/**
 * Parse a request body with a shared Zod schema; a ZodError becomes a 400
 * (not a 500 - the ValidationPipe doesn't handle raw Zod schemas).
 * Mirrors users.controller.ts:31-39.
 */
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
 * Parse query-string filters into the LeadFilterDto. `state` may repeat
 * (e.g. `?state=NEW&state=VISIT_REQUESTED`) - coerce to an array.
 */
function parseFilter(query: Record<string, unknown>): LeadFilterDto {
  const stateRaw = query['state'];
  let state: string | string[] | undefined;
  if (typeof stateRaw === 'string') {
    // The frontend joins multi-select states with a comma
    // (`state=NEW,CONTACTED`). Split before schema validation - a
    // literal "NEW,CONTACTED" is not a valid single LeadState enum value.
    const parts = stateRaw.split(',').map((s) => s.trim()).filter(Boolean);
    state = parts.length > 1 ? parts : parts[0];
    if (parts.length === 0) state = undefined;
  } else if (Array.isArray(stateRaw)) {
    state = stateRaw.filter((v): v is string => typeof v === 'string');
  }
  const candidate = {
    state,
    ownerId: typeof query['ownerId'] === 'string' ? query['ownerId'] : undefined,
    teamId: typeof query['teamId'] === 'string' ? query['teamId'] : undefined,
    projectId:
      typeof query['projectId'] === 'string' ? query['projectId'] : undefined,
    search: typeof query['search'] === 'string' ? query['search'] : undefined,
    limit:
      typeof query['limit'] === 'string' ? Number.parseInt(query['limit'], 10) : undefined,
    offset:
      typeof query['offset'] === 'string' ? Number.parseInt(query['offset'], 10) : undefined,
    sortBy: typeof query['sortBy'] === 'string' ? query['sortBy'] : undefined,
    sortDir: typeof query['sortDir'] === 'string' ? query['sortDir'] : undefined,
  };
  const result = LeadFilterDtoSchema.safeParse(candidate);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

@ApiTags('leads')
@ApiBearerAuth('jwt')
@Controller('leads')
export class LeadsController {
  // @Inject with an explicit token - tsx/esbuild does NOT emit
  // design:paramtypes (same reason users.controller.ts:48 uses it).
  constructor(
    @Inject(LeadsService) private readonly leads: LeadsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List leads (Lead Inbox). Role-scoped: TELECALLER/SALES_EXEC see own; MANAGER sees team; ADMIN/OWNER sees all.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<LeadListResult> {
    return this.leads.list(req.user!, parseFilter(query));
  }

  @Get('badge')
  @ApiOperation({
    summary:
      'Count NEW leads the actor can see in a project (sidebar badge). Role-scoped like the inbox; project-scoped via ?projectId=.',
  })
  async badge(
    @Req() req: AuthedRequest,
    @Query('projectId') projectId?: string,
  ): Promise<{ newLeads: number }> {
    // projectId is optional (a null/absent value means "all projects the
    // actor can see"). Validate format when present.
    if (projectId !== undefined && projectId.length > 0) {
      const idSchema = z.cuid2();
      if (!idSchema.safeParse(projectId).success) {
        throw new BadRequestException(`projectId "${projectId}" is not a valid id`);
      }
    }
    return this.leads.badgeCount(req.user!, projectId);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a single lead (Lead Detail page). Role-scoped by the same RLS policies as the inbox; a lead the actor cannot see 404s.',
  })
  async findOne(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<LeadDetail> {
    const idSchema = z.string().cuid2();
    if (!idSchema.safeParse(id).success) {
      throw new BadRequestException(`Lead id "${id}" is not a valid id`);
    }
    return this.leads.findOne(req.user!, id);
  }

  @Get(':id/activities')
  @ApiOperation({
    summary:
      'Get a lead timeline (oldest → newest). Each entry carries the acting user name for the UI.',
  })
  async getActivities(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<LeadActivity[]> {
    const idSchema = z.string().cuid2();
    if (!idSchema.safeParse(id).success) {
      throw new BadRequestException(`Lead id "${id}" is not a valid id`);
    }
    return this.leads.activities(req.user!, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new lead (owner assigned by stub rule)' })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<LeadRow> {
    const dto: CreateLeadDto = parseBody(CreateLeadDtoSchema, body);
    return this.leads.create(req.user!, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Partial update - name, email only. State transitions go through /transition.',
  })
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LeadRow> {
    const parsed = parseBody(UpdateLeadDtoSchema, body);
    const dto: UpdateLeadDto = { ...parsed, id };
    return this.leads.update(req.user!, id, dto);
  }

  @Post(':id/transition')
  @ApiOperation({
    summary:
      'Drive the Model C state machine (DECISION-CHANGELOG §3). Server enforces role + transition guards.',
  })
  async transition(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LeadRow> {
    const parsed = parseBody(LeadStateTransitionDtoSchema, body);
    const dto: LeadStateTransitionDto = { ...parsed, leadId: id };
    return this.leads.transition(req.user!, dto);
  }

  @Post(':id/reassign')
  @ApiOperation({
    summary:
      'Manual reassign (Plan §18 D2/D3). Allowed for ADMIN (any team) and MANAGER (same team). Server enforces the role + team + state-lane checks inside one withRlsContext transaction.',
  })
  async reassign(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<LeadRow> {
    // The DTO already carries `leadId`; the param `id` is the
    // URL-authoritative lead id. The DTO's leadId is set from
    // the param (matches the transition endpoint's pattern) so
    // a malicious body can't reassign a different lead.
    const parsed = parseBody(ReassignLeadDtoSchema, body);
    if (parsed.leadId !== id) {
      // Belt + suspenders: the param is the source of truth. The
      // body could try to claim a different leadId; reject.
      throw new BadRequestException(
        'leadId in body does not match URL id',
      );
    }
    const dto: ReassignLeadDto = parsed;
    return this.leads.reassign(req.user!, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      'Hard delete (autoplan 2026-09-07 D13/D14). OWNER/ADMIN only - mirrors the lead_delete_admin RLS policy. 409 when the lead is WON or has any booking (revenue/audit trail must not cascade away). Guard + delete run as ONE statement inside the RLS transaction (no check-then-act race).',
  })
  async delete(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    // URL-authoritative param check (eng review: unvalidated param was a
    // LOW finding). Cuid format pins "this is a lead id" before the DB
    // round trip; a mismatch is a client bug, not a "not found".
    const idSchema = z.string().cuid2();
    if (!idSchema.safeParse(id).success) {
      throw new BadRequestException(`Lead id "${id}" is not a valid id`);
    }
    return this.leads.delete(req.user!, id);
  }
}