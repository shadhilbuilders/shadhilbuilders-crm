// Inventory controller - list + detail + create + update + phases.
//
// Mirrors apps/backend/src/bookings/bookings.controller.ts and
// apps/backend/src/leads/leads.controller.ts patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit
//     design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//   - Query-string array coercion handled in the controller
//     (NestJS @Query gives string | string[] | undefined)
//
// Endpoint shapes match the web hooks (apps/web/src/hooks/queries/inventory.ts):
//   - GET    /api/inventory/units       - list (useInventoryUnits hook)
//   - GET    /api/inventory/units/:id   - detail (useInventoryUnit hook)
//   - POST   /api/inventory/units       - create (useCreateUnit hook)
//   - PATCH  /api/inventory/units/:id   - update (useUpdateUnit hook)
//   - GET    /api/inventory/phases      - phases (useInventoryPhases hook)
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
  CreateUnitDtoSchema,
  UnitFilterDtoSchema,
  UpdateUnitDtoSchema,
  type CreateUnitDto,
  type PhaseRow,
  type UnitFilterDto,
  type UnitListResult,
  type UnitRow,
  type UpdateUnitDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { InventoryService } from './inventory.service';

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

// cuid regex (matches api-types inventory.ts)
const CUID_RE = /^c[a-z0-9]{20,}$/i;

@ApiTags('inventory')
@ApiBearerAuth('jwt')
@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(InventoryService) private readonly inventory: InventoryService,
  ) {}

  @Get('units')
  @ApiOperation({
    summary:
      'List inventory units (villa grid). Filters: projectId/phaseId/bhk/facing/status. Every authenticated role can read.',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<UnitListResult> {
    // NestJS @Query gives string | string[] | undefined; coerce status
    // to a string-or-array and numeric params to numbers before safeParse.
    const statusRaw = query['status'];
    let status: string | string[] | undefined;
    if (typeof statusRaw === 'string') {
      // The frontend joins multi-select statuses with a comma
      // (`status=AVAILABLE,HOLD`). Split before schema validation - a
      // literal "AVAILABLE,HOLD" is not a valid single UnitStatus enum value.
      const parts = statusRaw.split(',').map((s) => s.trim()).filter(Boolean);
      status = parts.length > 1 ? parts : parts[0];
      if (parts.length === 0) status = undefined;
    } else if (Array.isArray(statusRaw)) {
      status = statusRaw.filter((v): v is string => typeof v === 'string');
    }
    const bhk =
      typeof query['bhk'] === 'string'
        ? Number.parseInt(query['bhk'], 10)
        : undefined;
    const limit =
      typeof query['limit'] === 'string'
        ? Number.parseInt(query['limit'], 10)
        : undefined;
    const offset =
      typeof query['offset'] === 'string'
        ? Number.parseInt(query['offset'], 10)
        : undefined;
    const candidate = {
      projectId:
        typeof query['projectId'] === 'string' ? query['projectId'] : undefined,
      phaseId:
        typeof query['phaseId'] === 'string' ? query['phaseId'] : undefined,
      bhk,
      facing: typeof query['facing'] === 'string' ? query['facing'] : undefined,
      status,
      limit,
      offset,
    };
    const dto: UnitFilterDto = parseBody(UnitFilterDtoSchema, candidate);
    return this.inventory.list(req.user!, dto);
  }

  @Get('units/:id')
  @ApiOperation({
    summary:
      'Get a single inventory unit (detail panel). Every authenticated role can read.',
  })
  async findOne(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<UnitRow> {
    if (!CUID_RE.test(id)) {
      throw new BadRequestException(`Invalid unit id: ${id}`);
    }
    return this.inventory.findOne(req.user!, id);
  }

  @Get('phases')
  @ApiOperation({
    summary:
      'List phases (optionally for a project) with unit counts. Feeds the filter + detail panel.',
  })
  async phases(
    @Req() req: AuthedRequest,
    @Query('projectId') projectId?: string,
  ): Promise<PhaseRow[]> {
    return this.inventory.phases(req.user!, projectId);
  }

  @Post('units')
  @ApiOperation({
    summary:
      'Create a new inventory unit. ADMIN/OWNER only (DESIGN.md §4). Audit row records the actor + unit.',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<UnitRow> {
    const dto: CreateUnitDto = parseBody(CreateUnitDtoSchema, body);
    return this.inventory.create(req.user!, dto);
  }

  @Patch('units/:id')
  @ApiOperation({
    summary:
      'Update an inventory unit (unitNumber/bhk/facing/sqft/price/status). ADMIN/OWNER only. Audit row with before/after.',
  })
  async update(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<UnitRow> {
    if (!CUID_RE.test(id)) {
      throw new BadRequestException(`Invalid unit id: ${id}`);
    }
    const dto: UpdateUnitDto = parseBody(UpdateUnitDtoSchema, body);
    return this.inventory.update(req.user!, id, dto);
  }

  @Delete('units/:id')
  @ApiOperation({
    summary:
      'Delete an inventory unit. ADMIN/OWNER only. 409 when the unit has bookings (Booking FK is Restrict). Audit row records the deleted unit.',
  })
  async remove(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    if (!CUID_RE.test(id)) {
      throw new BadRequestException(`Invalid unit id: ${id}`);
    }
    return this.inventory.delete(req.user!, id);
  }
}
