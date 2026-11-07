// Customer-progress Nest module (issue #7 slice 1).
// PrismaModule + StorageModule are @Global() (rule 7i): register once in
// AppModule, inject anywhere - hence no imports here.
import { Module } from '@nestjs/common';

import { CustomerPortalModule } from '../customer-portal/customer-portal.module';
import { CustomerProgressController } from './customer-progress.controller';
import { CustomerProgressService } from './customer-progress.service';

@Module({
  imports: [CustomerPortalModule], // PortalNotifier: buyer push after upload (issue #8)
  controllers: [CustomerProgressController],
  providers: [CustomerProgressService],
})
export class CustomerProgressModule {}