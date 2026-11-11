// Customer-portal Nest module (issue #8 slice 2).
// PrismaModule and PushModule are @Global(): no explicit imports. Exports the
// PortalNotifier so CustomerProgressModule can fire it after an upload commits
// (one-way dependency: portal never imports customer-progress).
import { Module } from '@nestjs/common';

import { CustomerPortalController } from './customer-portal.controller';
import { CustomerPortalService } from './customer-portal.service';
import { PortalNotifier } from './portal-notifier.service';

@Module({
  controllers: [CustomerPortalController],
  providers: [CustomerPortalService, PortalNotifier],
  exports: [PortalNotifier],
})
export class CustomerPortalModule {}
