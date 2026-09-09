// Push module - web push (VAPID) subscription + delivery.
//
// @Global() (rule 7i): NotificationsService (and any domain service) can
// inject PushService to fire a web push alongside an in-app notification.
// Registered once in AppModule.
import { Global, Module } from '@nestjs/common';

import { PushController } from './push.controller';
import { PushService } from './push.service';

@Global()
@Module({
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
