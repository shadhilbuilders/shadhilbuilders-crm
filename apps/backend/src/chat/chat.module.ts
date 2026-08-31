// Chat module (in-app + WhatsApp inbound).
// SSE support (eng review A9) lands in Phase 2.
import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('chat')
@ApiBearerAuth('jwt')
@Controller('chat')
class ChatController {
  @Get()
  list(): { message: string; phase: number } {
    return { message: 'Chat module lands in Week 6', phase: 1 };
  }
}

@Module({ controllers: [ChatController] })
export class ChatModule {}
