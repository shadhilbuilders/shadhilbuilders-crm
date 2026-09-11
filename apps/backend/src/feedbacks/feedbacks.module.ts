// Feedback - module.
import { Module } from '@nestjs/common';

import { FeedbackAdminController, FeedbackPublicController } from './feedbacks.controller';
import { FeedbacksService } from './feedbacks.service';

@Module({
  controllers: [FeedbackAdminController, FeedbackPublicController],
  providers: [FeedbacksService],
  exports: [FeedbacksService],
})
export class FeedbacksModule {}
