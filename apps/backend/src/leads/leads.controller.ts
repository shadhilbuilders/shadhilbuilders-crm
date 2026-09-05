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
    state = stateRaw;
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
}