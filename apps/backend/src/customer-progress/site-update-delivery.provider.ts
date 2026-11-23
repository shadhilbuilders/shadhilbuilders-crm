// Nest wiring, so the WhatsApp leg needs no manual construction.
//
// Every dependency is optional on purpose. `SiteUpdateDeliveryService` is a
// follow-up to a save that already committed: a deployment without the outbox
// (tests, a slim worker) must still boot and still save site updates, and the
// delivery row then records FAILED with a reason rather than the save failing.
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

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
    @Optional() @Inject(OutboundService) outbound?: OutboundService,
    @Optional() @Inject(STORAGE_PROVIDER) storage?: StorageProvider,
  ) {
    // NO PrismaService here. This class used to take it and hand its raw
    // `$client` to the core, which never used it: every query runs on the RLS
    // transaction the caller passes as `input.tx`. Dropping the parameter is what
    // keeps the bare-prisma guardrail honest instead of adding an allowlist entry
    // for a capability nobody needs.
    this.core = new DeliveryCore({
      outbound,
      storage,
      logger: this.logger,
    });
  }

  recordAndSend(input: DeliveryInput): Promise<void> {
    return this.core.recordAndSend(input);
  }
}
