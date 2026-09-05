// Realtime ticket-mint controller - owns the POST /api/realtime/ticket
// endpoint. The SSE consumer endpoints (GET /api/sse/*) live in the
// standalone apps/realtime-sse/ service (T-E2 fix, 2026-09-04).
//
// Why the split: @nestjs/core 12.0.1's @Sse() handler is broken for
// any subscription chain that requires an await inside its factory
// (see ~/.hermes/skills/devops/shadhil-crm-dev/references/ci-workflow-pitfalls.md
// Pitfall 9). The standalone service uses bare node:http to avoid the
// framework layer entirely. The ticket mint stays in Nest because it
// fits the existing JWT-auth + service-injection pattern.

import { Body, Controller, Inject, Module, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthedRequest } from '../auth/jwt-auth.guard';
import type { MintTicketDto, MintTicketResponse } from '@shadhil/api-types';

import { RealtimeService } from './realtime.service';

@ApiTags('realtime')
@ApiBearerAuth('jwt')
@Controller('realtime')
export class RealtimeTicketController {
  constructor(
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
  ) {}

  @Post('ticket')
  @ApiOperation({
    summary:
      'Mint a 5-minute single-use stream ticket for an SSE channel (notifications | audit | chat:<leadId>).',
  })
  async mint(
    @Req() req: AuthedRequest,
    @Body() body: unknown,
  ): Promise<MintTicketResponse> {
    // Body parse: the shared Zod schema in api-types (MintTicketDtoSchema)
    // is applied in the service via parseChannel + channel checks. The
    // minimal shape check here mirrors the parseBody helper pattern.
    const raw = body as { channel?: unknown };
    if (
      raw === null ||
      typeof raw !== 'object' ||
      typeof raw.channel !== 'string' ||
      raw.channel.length === 0
    ) {
      const err = new Error('body.channel must be a non-empty string');
      (err as Error & { status?: number }).status = 400;
      throw err;
    }
    return this.realtime.mintTicket(req.user!, { channel: raw.channel });
  }
}

@Module({
  controllers: [RealtimeTicketController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
