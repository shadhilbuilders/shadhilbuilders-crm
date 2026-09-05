// T-E2b follow-up queue — controller.
//
// Endpoints (all require ADMIN/OWNER/MANAGER via the JWT guard —
// the role gate is on the page nav, not here, so we can re-use
// the standard JwtAuthGuard which just checks for a valid JWT).
//
//   GET    /api/whatsapp-unknown-contacts?status=...&limit=...&cursor=...
//   POST   /api/whatsapp-unknown-contacts/:id/convert
//   POST   /api/whatsapp-unknown-contacts/:id/spam
//
// Pattern matches apps/backend/src/notifications/notifications.controller.ts:
//   - @Inject with explicit token
//   - parseBody(schema, body) helper turns ZodError → 400
//   - parseQuery(schema, query) for GET filters
//   - @ApiTags + @ApiBearerAuth Swagger decorators

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ConvertUnknownContactDtoSchema,
  WhatsappUnknownContactListQuerySchema,
  type ConvertUnknownContactDto,
  type WhatsappUnknownContactListQuery,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';

import {
  WhatsappUnknownContactsService,
  type ConvertUnknownContactResult,
  type SpamUnknownContactResult,
  type WhatsappUnknownContactListResult,
} from './whatsapp-unknown-contacts.service';

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

function parseQuery<T>(
  schema: z.ZodType<T>,
  query: Record<string, string | string[] | undefined>,
): T {
  // Express/Nest's query is `string | string[] | undefined`. Coerce
  // array values to their first element (matches the chat/audit
  // controller patterns — most query params are single-valued).
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (Array.isArray(v)) normalized[k] = v[0];
    else if (v !== undefined) normalized[k] = v;
  }
  const result = schema.safeParse(normalized);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map(
        (i) => `${i.path.join('.') || 'query'}: ${i.message}`,
      ),
    );
  }
  return result.data;
}

@ApiTags('whatsapp-unknown-contacts')
@ApiBearerAuth()
@Controller('whatsapp-unknown-contacts')
export class WhatsappUnknownContactsController {
  constructor(
    @Inject(WhatsappUnknownContactsService)
    private readonly service: WhatsappUnknownContactsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the WhatsApp follow-up queue (admin-class only)',
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<WhatsappUnknownContactListResult> {
    const dto: WhatsappUnknownContactListQuery = parseQuery(
      WhatsappUnknownContactListQuerySchema,
      query,
    );
    return this.service.list(req.user!, dto);
  }

  @Post(':id/convert')
  @ApiOperation({
    summary:
      'Convert an unknown contact to a Lead. Creates the Lead ' +
      '(with manager assignment + audit log) and links the contact ' +
      'in one transaction. The body is the same CreateLeadDto as ' +
      'POST /api/leads; the source field is forced to "WHATSAPP".',
  })
  async convert(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<ConvertUnknownContactResult> {
    const dto: ConvertUnknownContactDto = parseBody(
      ConvertUnknownContactDtoSchema,
      body,
    );
    return this.service.convert(req.user!, id, dto);
  }

  @Post(':id/spam')
  @ApiOperation({
    summary:
      'Mark a contact as SPAM (wrong number / bot / not interested). ' +
      'Idempotent on already-SPAM rows. Refuses CONVERTED rows (use ' +
      'notes instead — a SPAM would orphan the linked Lead).',
  })
  async spam(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SpamUnknownContactResult> {
    return this.service.markSpam(req.user!, id);
  }
}
