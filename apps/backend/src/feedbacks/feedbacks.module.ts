// Feedback - module.
import { Module } from '@nestjs/common';

import { FeedbackAdminController, FeedbackPublicController } from './feedbacks.controller';
import { FeedbackNotifier } from './feedback-notifier.service';
import { FeedbacksService } from './feedbacks.service';

@Module({
  controllers: [FeedbackAdminController, FeedbackPublicController],
  // FeedbackNotifier tells the admin class a new row landed. NotificationsService
  // is @Global() (rule 7i), so it needs no imports entry.
  providers: [FeedbacksService, FeedbackNotifier],
  exports: [FeedbacksService],
})
export class FeedbacksModule {}
