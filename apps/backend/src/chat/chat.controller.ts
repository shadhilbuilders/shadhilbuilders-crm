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
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ChatConversationsQuerySchema,
  MarkChatReadDtoSchema,
  MessageKindSchema,
  SendContactMessageDtoSchema,
  SendMessageDtoSchema,
  type ChatConversationsResult,
  type MarkChatReadDto,
  type SendContactMessageDto,
  type SendMessageDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { JwtPayload } from '@shadhil/auth';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import { canUseWhatsappInbox } from '../users/roles';
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

  // Lead ids are cuid2 - validate strictly (a `c`-only regex rejects real
  // cuid2 ids that don't start with 'c').
  private static readonly CUID_RE = z.cuid2();

  /**
   * T-WA-INBOX (2026-09-25): gate the whole WhatsApp chat surface to
   * manager-and-above, matching the RLS policies and the web nav helper.
   * Throwing 403 (not an empty list) is deliberate: a staff user who guesses
   * the URL should be told no, rather than shown a misleading empty inbox.
   */
  private assertInboxAccess(actor: JwtPayload): void {
    if (!canUseWhatsappInbox(actor.role)) {
      throw new ForbiddenException(
        'The WhatsApp chat system is available to managers, admins and owners only.',
      );
    }
  }

  /**
   * GET /api/chat/conversations - the inbox list: every WhatsApp thread the
   * actor may see, both known-lead and not-yet-converted contacts.
   *
   * Declared BEFORE `@Get(':leadId')` because Nest matches routes in
   * declaration order - with the catch-all first, "conversations" would be
   * captured as a leadId and 400 on cuid validation.
   */
  @Get('conversations')
  @ApiOperation({
    summary:
      'List WhatsApp conversations (leads + unknown contacts) with unread counts. MANAGER/ADMIN/OWNER only.',
  })
  async conversations(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, string | undefined>,
  ): Promise<ChatConversationsResult> {
    const actor = req.user!;
    this.assertInboxAccess(actor);
    // Coerce query strings (the BFF forwards them verbatim) through the Zod
    // schema so limit/offset/unreadOnly arrive as the right types.
    const parsed = ChatConversationsQuerySchema.safeParse({
      search: query['search'],
      kind: query['kind'],
      unreadOnly: query['unreadOnly'],
      limit: query['limit'],
      offset: query['offset'],
    });
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`),
      );
    }
    return this.chat.conversations(actor, parsed.data);
  }

  /** GET /api/chat/contact/:contactId - messages on a contact thread. */
  @Get('contact/:contactId')
  @ApiOperation({
    summary:
      'List messages on an unknown-contact WhatsApp thread. MANAGER/ADMIN/OWNER only.',
  })
  async listContact(
    @Req() req: AuthedRequest,
    @Param('contactId') contactId: string,
  ): Promise<MessageListResult> {
    const actor = req.user!;
    this.assertInboxAccess(actor);
    if (contactId.trim().length === 0 || contactId.length > 60) {
      throw new BadRequestException(`Invalid contactId: ${contactId}`);
    }
    return this.chat.listContact(actor, contactId, 200);
  }

  /** POST /api/chat/send-to-contact - reply on an unknown-contact thread. */
  @Post('send-to-contact')
  @ApiOperation({
    summary:
      'Send a WhatsApp reply to an unknown contact. Enqueues the Meta outbound. MANAGER/ADMIN/OWNER only.',
  })
  async sendToContact(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<MessageRow> {
    const actor = req.user!;
    this.assertInboxAccess(actor);
    const dto: SendContactMessageDto = parseBody(SendContactMessageDtoSchema, body);
    return this.chat.sendToContact(actor, dto);
  }

  /** POST /api/chat/read - mark a thread read for the current user. */
  @Post('read')
  @ApiOperation({
    summary: 'Mark a chat thread read for the calling user (per-user unread).',
  })
  async markRead(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const actor = req.user!;
    this.assertInboxAccess(actor);
    const dto: MarkChatReadDto = parseBody(MarkChatReadDtoSchema, body);
    return this.chat.markRead(actor, dto);
  }

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
    if (!ChatController.CUID_RE.safeParse(leadId).success) {
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
