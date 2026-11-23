// Customer-progress Nest module (issue #7 slice 1).
// PrismaModule + StorageModule are @Global() (rule 7i): register once in
// AppModule, inject anywhere - hence no imports here.
import { Module } from '@nestjs/common';

import { CustomerPortalModule } from '../customer-portal/customer-portal.module';
import { CustomerProgressController } from './customer-progress.controller';
import { CustomerProgressService } from './customer-progress.service';
import { SITE_VIDEO_CONFIG, readSiteVideoConfig } from './site-video.config';
import { SiteVideoController } from './site-video.controller';
import { SiteVideoRateLimiter } from './site-video-rate-limiter';
import { SiteVideoService } from './site-video.service';
import { SiteUnitsService } from './site-units.service';
import { SiteUpdateNotifier } from './site-update-notifier.service';

@Module({
  imports: [CustomerPortalModule], // PortalNotifier: buyer push after upload (issue #8)
  controllers: [CustomerProgressController, SiteVideoController],
  // NotificationsService is @Global() (rule 7i), so SiteUpdateNotifier needs no
  // imports entry for it.
  providers: [
    CustomerProgressService,
    SiteUpdateNotifier,
    SiteUnitsService,
    SiteVideoService,
    SiteVideoRateLimiter,
    // Read once at module init. main.ts also calls readSiteVideoConfig() before
    // Nest starts so a bad config exits with the full list of problems.
    { provide: SITE_VIDEO_CONFIG, useFactory: () => readSiteVideoConfig() },
  ],
})
export class CustomerProgressModule {}
