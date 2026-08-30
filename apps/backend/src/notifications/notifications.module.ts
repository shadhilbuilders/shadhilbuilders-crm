// Notifications module — in-app inbox + push delivery (Expo + VAPID).
import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';

@ApiTags('notifications')
@ApiBearerAuth('jwt')
@Controller('notifications')
class NotificationsController {
  @Public()
  @Get()
  list(): { message: string; phase: number } {
    return { message: 'Notifications + push delivery lands in Week 7', phase: 1 };
  }
}

@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
