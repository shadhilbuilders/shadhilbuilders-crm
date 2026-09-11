// Notifications controller - list current user's inbox + mark-as-read.
//
// Mirrors apps/backend/src/leads/leads.controller.ts and
// apps/backend/src/visits/visits.controller.ts patterns:
//   - @Inject with explicit token (tsx/esbuild doesn't emit
//     design:paramtypes)
//   - parseBody(schema, body) helper turns ZodError → 400
//   - @ApiTags + @ApiBearerAuth Swagger decorators
//   - Query-string boolean coercion for `unreadOnly=true`
//
// Endpoint shapes match the web hooks (apps/web/src/hooks/queries/crm.ts):
//   - GET   /api/notifications              - list (useNotifications hook)
//   - PATCH /api/notifications/mark-read    - mark read (useMarkNotificationsRead hook)
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  MarkReadDtoSchema,
  NotificationFilterDtoSchema,
  type MarkReadDto,
  type NotificationFilterDto,
} from '@shadhil/api-types';
import { z } from 'zod';

import type { AuthedRequest } from '../auth/jwt-auth.guard';
import {
  NotificationsService,
  type NotificationListResult,
} from './notifications.service';

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

@ApiTags('notifications')
@ApiBearerAuth('jwt')
@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(NotificationsService) private readonly notifications: NotificationsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "List current user's notifications. ?unreadOnly=true filters to unread.",
  })
  async list(
    @Req() req: AuthedRequest,
    @Query() query: Record<string, unknown>,
  ): Promise<NotificationListResult> {
    // Coerce the boolean string from Next.js BFF (always string in
    // query strings).
    const unreadOnlyRaw = query['unreadOnly'];
    const unreadOnly =
      unreadOnlyRaw === 'true' || unreadOnlyRaw === true;
    const limit =
      typeof query['limit'] === 'string'
        ? Number.parseInt(query['limit'], 10)
        : undefined;
    const offset =
      typeof query['offset'] === 'string'
        ? Number.parseInt(query['offset'], 10)
        : undefined;
    const dto: NotificationFilterDto = parseBody(
      NotificationFilterDtoSchema,
      {
        unreadOnly,
        type: typeof query['type'] === 'string' ? query['type'] : undefined,
        typePrefix:
          typeof query['typePrefix'] === 'string'
            ? query['typePrefix']
            : undefined,
        // T-ProjectSwitch: filter notifications by the active project
        // (resolved through Notification.lead.projectId in the service).
        projectId:
          typeof query['projectId'] === 'string'
            ? query['projectId']
            : undefined,
        limit,
        offset,
      },
    );
    return this.notifications.list(req.user!, dto);
  }

  @Patch('mark-read')
  @ApiOperation({
    summary:
      "Mark current user's notifications as read. Empty array = mark all unread.",
  })
  async markRead(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<{ updated: number }> {
    const dto: MarkReadDto = parseBody(MarkReadDtoSchema, body);
    return this.notifications.markRead(req.user!, dto);
  }
}
