// Public leads - module (landing-page enquiry → Lead).
//
// Imports LeadsModule so PublicLeadsController → PublicLeadsService → 
// LeadsService.create() resolve through DI. The public controller is the
// ONLY controller in this module; it rides the @Public() + ApiKeyGuard
// (PUBLIC_API_KEY) pattern from the feedback public endpoint.
import { Module } from '@nestjs/common';

import { LeadsModule } from '../leads/leads.module';

import { PublicLeadsController } from './public-leads.controller';
import { PublicLeadsService } from './public-leads.service';

@Module({
  imports: [LeadsModule],
  controllers: [PublicLeadsController],
  providers: [PublicLeadsService],
  exports: [PublicLeadsService],
})
export class PublicLeadsModule {}
