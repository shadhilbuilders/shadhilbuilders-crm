// Push service - web push (VAPID) subscription + delivery.
//
// T-PUSH (2026-09-08): wires the PushSubscription / PushNotification models
// (schema.prisma §14-15) + the RegisterPushDtoSchema contract (api-types).
// WEB uses VAPID via the `web-push` library; IOS/ANDROID route through Expo
// Push (not implemented yet - the DTO accepts the platform but only WEB is
// delivered today).
//
// Best-effort (rule 7j): the service must boot and run without VAPID keys
// (no-op with a one-time warn), and a transient push failure must never
// break the request path. Every external call is wrapped in try/catch.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { rlsContextFrom, withRlsContext, type PrismaClient } from '@shadhil/database';
import type { JwtPayload } from '@shadhil/auth';
import type { RegisterPushDto } from '@shadhil/api-types';
import webpush from 'web-push';

import { PrismaService } from '../prisma/prisma.module';

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  /** Collapses repeat notifications for the same subject on the device. */
  tag?: string;
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly enabled: boolean;

  constructor(@Inject(PrismaService) private readonly prismaService: PrismaService) {
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@shadhilbuilders.in';
    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.enabled = true;
    } else {
      this.enabled = false;
      this.logger.warn(
        '[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing - web push disabled (no-op).',
      );
    }
  }

  private get client(): PrismaClient {
    return this.prismaService.$client;
  }

  /** The VAPID public key the web app needs to subscribe. Null when disabled. */
  get publicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY?.trim() || null;
  }

  /**
   * POST /api/push/subscribe - upsert a push subscription for the actor.
   * Same endpoint is idempotent: re-subscribing with the same endpoint
   * updates p256dh/auth (browsers rotate keys on re-subscribe).
   */
  async subscribe(actor: JwtPayload, dto: RegisterPushDto): Promise<{ ok: true }> {
    return withRlsContext(this.client, rlsContextFrom(actor), async (tx) => {
      await (tx as unknown as PrismaClient).pushSubscription.upsert({
        where: { endpoint: dto.endpoint },
        create: {
          userId: actor.sub,
          organizationId: actor.organizationId,
          endpoint: dto.endpoint,
          p256dh: dto.p256dh,
          auth: dto.auth,
          platform: dto.platform,
        },
        update: {
          userId: actor.sub,
          p256dh: dto.p256dh,
          auth: dto.auth,
          platform: dto.platform,
        },
      });
      return { ok: true };
    });
  }

  /**
   * Send a web push to every WEB subscription the user owns. Best-effort:
   * a failed send is logged + recorded in PushNotification, never thrown.
   * Returns the number of subscriptions attempted.
   *
   * Runs inside withRlsContext(recipient) so the PushSubscription read and
   * the PushNotification write satisfy their owner-scoped RLS policies
   * (app.user_id = recipient).
   */
  async sendToUser(userId: string, payload: PushPayload, organizationId: string): Promise<number> {
    return this.sendAs(userId, 'TELECALLER', payload, organizationId);
  }

  /**
   * Deliver one payload to several recipients (issue #8: the customer portal
   * photo notifier). Each recipient is processed in their OWN RLS context
   * (the push policies are owner-scoped: app.user_id = recipient), so one
   * recipient's expired subscription (404/410 -> deleted by deliver()) or
   * failure never affects another's. Never throws; returns the number of
   * subscriptions attempted across all recipients.
   */
  async sendToUsers(
    organizationId: string,
    userIds: readonly string[],
    payload: PushPayload,
    role: 'CUSTOMER' | 'TELECALLER' = 'CUSTOMER',
  ): Promise<number> {
    let attempted = 0;
    for (const userId of new Set(userIds)) {
      try {
        attempted += await this.sendAs(userId, role, payload, organizationId);
      } catch (err) {
        this.logger.warn(
          `[push] recipient ${userId} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    return attempted;
  }

  private async sendAs(
    userId: string,
    role: 'CUSTOMER' | 'TELECALLER',
    payload: PushPayload,
    organizationId: string,
  ): Promise<number> {
    if (!this.enabled) return 0;
    return withRlsContext(this.client, { userId, role, organizationId }, async (tx) => {
      const subs = await (tx as unknown as PrismaClient).pushSubscription.findMany({
        where: { userId, platform: 'WEB' },
      });
      for (const sub of subs) {
        await this.deliver(
          tx as unknown as PrismaClient,
          userId,
          organizationId,
          sub.endpoint,
          sub.p256dh,
          sub.auth,
          payload,
        );
      }
      return subs.length;
    });
  }

  private async deliver(
    client: PrismaClient,
    userId: string,
    organizationId: string,
    endpoint: string,
    p256dh: string,
    auth: string,
    payload: PushPayload,
  ): Promise<void> {
    try {
      await webpush.sendNotification({ endpoint, keys: { p256dh, auth } }, JSON.stringify(payload));
      await client.pushNotification.create({
        data: {
          userId,
          organizationId,
          type: 'web',
          payload,
          status: 'DELIVERED',
          sentAt: new Date(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `[push] send failed for ${endpoint}: ${err instanceof Error ? err.message : err}`,
      );
      // 404/410 = subscription gone; drop it so we don't retry forever.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await client.pushSubscription.delete({ where: { endpoint } }).catch(() => undefined);
      }
    }
  }
}
