// Notifications module — in-app inbox + push delivery (Expo + VAPID).
import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('notifications')
@ApiBearerAuth('jwt')
@Controller('notifications')
class NotificationsController {
  @Get()
  list(): { message: string; phase: number } {
    return { message: 'Notifications + push delivery lands in Week 7', phase: 1 };
  }
}

@Module({ controllers: [NotificationsController] })
export class NotificationsModule {}
