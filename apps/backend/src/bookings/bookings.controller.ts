// Bookings controller - list + create + transition.
//
// Mirrors apps/backend/src/leads/leads.controller.ts and
// apps/backend/src/visits/visits.controller.ts patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit
//     design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//   - Query-string array coercion handled in the controller
//     (NestJS @Query gives string | string[] | undefined)
//
// Endpoint shapes match the web hooks (apps/web/src/hooks/queries/crm.ts):
//   - GET    /api/bookings             - list (useBookings hook)
//   - POST   /api/bookings             - create (useCreateBooking hook)
//   - PATCH  /api/bookings/:id         - transition status (useUpdateBooking hook)
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
  BookingFilterDtoSchema,
  BookingTransitionDtoSchema,
  CreateBookingDtoSchema,
  type BookingFilterDto,
  type BookingTransitionDto,
  type CreateBookingDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import {
  BookingsService,
  type BookingListResult,
  type BookingRow,
} from './bookings.service';

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

// cuid regex (matches api-types bookings.ts)
const CUID_RE = /^c[a-z0-9]{20,}$/i;

@ApiTags('bookings')
@ApiBearerAuth('jwt')
@Controller('bookings')
export class BookingsController {
  constructor(
    @Inject(BookingsService) private readonly bookings: BookingsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List bookings, role-scoped. ?status= filters by status (BookingStatus, repeatable).',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<BookingListResult> {
    // NestJS @Query gives string | string[] | undefined; coerce
    // status to a string-or-array before safeParse. The frontend joins
    // multi-select statuses with a comma (`status=HOLD,TOKEN`) - split
    // before schema validation, a literal "HOLD,TOKEN" is not a valid
    // single BookingStatus enum value (mirrors the inventory controller).
    const statusRaw = query['status'];
    let status: string | string[] | undefined;
    if (typeof statusRaw === 'string') {
      const parts = statusRaw.split(',').map((s) => s.trim()).filter(Boolean);
      status = parts.length > 1 ? parts : parts[0];
      if (parts.length === 0) status = undefined;
    } else if (Array.isArray(statusRaw)) {
      status = statusRaw.filter((v): v is string => typeof v === 'string');
    }
    const candidate = {
      ...query,
      status,
      projectId:
        typeof query['projectId'] === 'string' ? query['projectId'] : undefined,
      limit:
        typeof query['limit'] === 'string'
          ? Number.parseInt(query['limit'], 10)
          : undefined,
      offset:
        typeof query['offset'] === 'string'
          ? Number.parseInt(query['offset'], 10)
          : undefined,
    };
    const dto: BookingFilterDto = parseBody(BookingFilterDtoSchema, candidate);
    return this.bookings.list(req.user!, dto);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a new booking in HOLD state. Audit row records the actor + amount.',
  })
  async create(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<BookingRow> {
    const dto: CreateBookingDto = parseBody(CreateBookingDtoSchema, body);
    return this.bookings.create(req.user!, dto);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a single booking (approval page). Role-scoped by the same RLS policies as list; a booking the actor cannot see 404s.',
  })
  async findOne(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<BookingRow> {
    if (!CUID_RE.test(id)) {
      throw new BadRequestException(`Invalid booking id: ${id}`);
    }
    return this.bookings.findOne(req.user!, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      'Advance booking state (HOLD → TOKEN → APPROVED, etc.). Manager-only approval.',
  })
  async transition(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BookingRow> {
    if (!CUID_RE.test(id)) {
      throw new BadRequestException(`Invalid booking id: ${id}`);
    }
    const dto: BookingTransitionDto = parseBody(
      BookingTransitionDtoSchema,
      body,
    );
    return this.bookings.transition(req.user!, id, dto);
  }
}
