// Chat controller - list messages for a lead + send a message.
//
// Mirrors apps/backend/src/leads/leads.controller.ts and
// apps/backend/src/visits/visits.controller.ts patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit
//     design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//
// Endpoint shapes match the web hooks:
//   - GET  /api/chat/:leadId          - list (useMessages(leadId) hook)
//   - POST /api/chat/send             - send (useSendMessage(leadId) hook)
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MessageKindSchema,
  SendMessageDtoSchema,
  type SendMessageDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { ChatService, type MessageListResult, type MessageRow } from './chat.service';

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

@ApiTags('chat')
@ApiBearerAuth('jwt')
@Controller('chat')
export class ChatController {
  constructor(
    @Inject(ChatService) private readonly chat: ChatService,
  ) {}

  // cuid regex (matches packages/api-types/src/chat.ts:MessageFilterDtoSchema)
  private static readonly CUID_RE = /^c[a-z0-9]{20,}$/i;

  @Get(':leadId')
  @ApiOperation({
    summary:
      'List messages for a lead (chronological). RLS-scoped via parent Lead team/owner. `kind` filters to a thread (default CUSTOMER).',
  })
  async list(
    @Req() req: AuthedRequest,
    @Param('leadId') leadId: string,
    @Query('kind') kind?: string,
  ): Promise<MessageListResult> {
    if (!ChatController.CUID_RE.test(leadId)) {
      throw new BadRequestException(`Invalid leadId: ${leadId}`);
    }
    // Validate the kind query param (default CUSTOMER). A bad value is a
    // 400, not a silent fall-through to CUSTOMER.
    const parsed = MessageKindSchema.safeParse(kind ?? 'CUSTOMER');
    if (!parsed.success) {
      throw new BadRequestException(`Invalid kind: ${kind}`);
    }
    // Hard cap 200 to mirror MessageFilterDtoSchema's max; the page
    // only ever sends the default 50 but a misconfigured BFF could
    // ask for more.
    return this.chat.list(req.user!, leadId, undefined, 200, parsed.data);
  }

  @Post('send')
  @ApiOperation({
    summary:
      'Send a message to a lead. direction=OUT, channel=IN_APP unless overridden.',
  })
  async send(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<MessageRow> {
    const dto: SendMessageDto = parseBody(SendMessageDtoSchema, body);
    return this.chat.send(req.user!, dto);
  }
}
