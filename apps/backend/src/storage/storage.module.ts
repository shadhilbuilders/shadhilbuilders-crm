// Media / storage module - chat attachments.
//
// MEDIA (2026-09-17): wires the StorageProvider + the MediaController
// (POST /api/media upload, GET /api/media/:key read). The provider is
// selected by MEDIA_STORAGE env at construction:
//   - MEDIA_STORAGE=imagekit  → ImageKitStorage   (prod; requires IK env)
//   - anything else / unset    → LocalDiskStorage  (dev/test default)
// This is a one-line-ish switch: consumers depend only on the
// StorageProvider interface.
//
// @Global() so ChatService / OutboundService / the inbound webhook can
// inject the storage directly (to read bytes back for Meta's /media
// upload on outbound media messages) without threading an imports chain
// through every consumer.
import { Global, Module } from '@nestjs/common';

import { ImageKitStorage } from './imagekit.storage';
import { LocalDiskStorage } from './local-disk.storage';
import { MediaController } from './media.controller';
import { STORAGE_PROVIDER } from './storage.tokens';

@Global()
@Module({
  controllers: [MediaController],
  providers: [
    {
      provide: STORAGE_PROVIDER,
      // imagekit constructor throws fail-fast if creds are missing, so only
      // construct it when explicitly requested. LocalDiskStorage needs none.
      useFactory: () =>
        process.env.MEDIA_STORAGE === 'imagekit'
          ? new ImageKitStorage()
          : new LocalDiskStorage(process.env.MEDIA_DIR ?? 'media'),
    },
    // LocalDiskStorage is deliberately NOT registered as a class provider.
    // Nest cannot resolve its `mediaDir: string` constructor parameter (a TS
    // default is not a DI token), so listing it here makes every boot fail with
    // "Nest can't resolve dependencies of the LocalDiskStorage (?)" - which took
    // the whole API down, e2e included. The factory above is the only consumer
    // and constructs it explicitly, so nothing needs the class as a token.
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
