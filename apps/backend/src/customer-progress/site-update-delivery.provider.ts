// Nest wiring, so the WhatsApp leg needs no manual construction.
//
// Every dependency is optional on purpose. `SiteUpdateDeliveryService` is a
// follow-up to a save that already committed: a deployment without the outbox
// (tests, a slim worker) must still boot and still save site updates, and the
// delivery row then records FAILED with a reason rather than the save failing.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.module';
import { OutboundService } from '../whatsapp/outbound.service';
import type { StorageProvider } from '../storage/storage.provider';
import { STORAGE_PROVIDER } from '../storage/storage.tokens';

import {
  SiteUpdateDeliveryService as DeliveryCore,
  type DeliveryInput,
} from './site-update-delivery.service';

@Injectable()
export class SiteUpdateDelivery implements Pick<DeliveryCore, 'recordAndSend'> {
  private readonly logger = new Logger(SiteUpdateDelivery.name);
  private readonly core: DeliveryCore;

  constructor(
    @Inject(PrismaService) prismaService: PrismaService,
    @Optional() @Inject(OutboundService) outbound?: OutboundService,
    @Optional() @Inject(STORAGE_PROVIDER) storage?: StorageProvider,
  ) {
    this.core = new DeliveryCore({
      client: prismaService.$client,
      outbound,
      storage,
      logger: this.logger,
    });
  }

  recordAndSend(input: DeliveryInput): Promise<void> {
    return this.core.recordAndSend(input);
  }
}
