// T-E2b — Telegram channel alert for systematic outbound-WhatsApp failure.
//
// The outbound cron (apps/backend/src/whatsapp/outbound.cron.ts) runs
// every 5s and counts `tick.failed` per tick. A single transient Meta
// 4xx isn't alarming (the row will retry per the backoff schedule);
// 3 ticks in a row where every claimed send failed IS alarming — Meta
// is down, the template is broken, or our token rotated.
//
// Alert path:
//
//   1. OutboundCronService.runOnce() completes, gets a tick result.
//   2. It calls AlertsService.recordTickResult(tick).
//   3. AlertsService keeps a rolling counter of "all-failed" ticks
//      (failed === claimed > 0). When the counter hits
//      TELEGRAM_ALERT_THRESHOLD, it fires a Telegram message via
//      TelegramService.sendChannelMessage() and starts a cooldown.
//   4. During the cooldown (TELEGRAM_ALERT_COOLDOWN_MS, default 15min),
//      additional failed ticks do NOT fire more alerts.
//   5. A tick with any success (`tick.sent > 0`) resets both the
//      counter and the cooldown.
//
// Failure mode: every method is best-effort. The cron MUST NOT crash
// because Telegram is down. TelegramService swallows network errors and
// logs them; AlertsService is pure state, no I/O.
//
// The module is @Global() so the cron service can inject AlertsService
// without importing the module chain explicitly (WhatsAppModule already
// imports PrismaModule + RedisModule and is itself @Global()).
import { Global, Injectable, Logger, Module } from '@nestjs/common';

import { type OutboundTickResult } from '../whatsapp/outbound.cron';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Default Telegram alert threshold. Three consecutive all-failed ticks
 *  (15s window at 5s/tick) before an alert fires. */
export const DEFAULT_TELEGRAM_ALERT_THRESHOLD = 3;

/** Default cooldown: suppress repeat alerts for 15 minutes after one fires. */
export const DEFAULT_TELEGRAM_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// TelegramService — thin HTTP wrapper around the Bot API.
// ---------------------------------------------------------------------------

export interface TelegramServiceOptions {
  /** Bot token from BotFather. If null/undefined, the service is a no-op. */
  botToken: string | undefined;
  /** Channel id (looks like "-100xxxxxxxxxx"). If null/undefined, the
   *  service is a no-op. */
  channelId: string | undefined;
  /** Display name surfaced in alert text (cosmetic). */
  botName: string;
  /** Override the API base URL — tests inject a stub. */
  apiBaseUrl?: string;
  /** Override fetch — tests inject a spy. */
  fetchImpl?: typeof fetch;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly enabled: boolean;
  private readonly token: string;
  private readonly chatId: string;
  /** Display name surfaced in alert text (cosmetic). */
  readonly botName: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramServiceOptions) {
    this.token = (opts.botToken ?? '').trim();
    this.chatId = (opts.channelId ?? '').trim();
    this.botName = opts.botName;
    this.apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.telegram.org').replace(
      /\/+$/,
      '',
    );
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.enabled = this.token.length > 0 && this.chatId.length > 0;
    if (!this.enabled) {
      this.logger.warn(
        `${this.botName}: Telegram disabled (missing TELEGRAM_BOT_TOKEN or ` +
          `TELEGRAM_CHANNEL_ID). Outbound systematic-failure alerts will be ` +
          `logged but not sent.`,
      );
    }
  }

  /**
   * Send a text message to the configured channel. Best-effort: never
   * throws. Returns `true` if the message was accepted by the Bot API,
   * `false` if the service is disabled or the API call failed.
   */
  async sendChannelMessage(text: string): Promise<boolean> {
    if (!this.enabled) {
      this.logger.debug(`Telegram disabled — would have sent: ${text}`);
      return false;
    }
    const url = `${this.apiBaseUrl}/bot${this.token}/sendMessage`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        // Body might be JSON with a description; we don't depend on it,
        // just log enough to debug.
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Telegram sendMessage ${res.status}: ${body.slice(0, 200)}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      // Network error or abort — never throw to the caller.
      this.logger.warn(
        `Telegram sendMessage threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// AlertsService — rolling counter + cooldown orchestrator.
// ---------------------------------------------------------------------------

export interface AlertsServiceOptions {
  /** Number of consecutive all-failed ticks before alert fires. */
  threshold: number;
  /** Milliseconds to suppress repeat alerts after one fires. */
  cooldownMs: number;
  /** Telegram service for the actual send. */
  telegram: TelegramService;
  /** Display name for the env we're running in (e.g. "production"). */
  environment: string;
  /** "now" hook — tests inject a controllable clock. */
  now?: () => number;
}

export type AlertTickOutcome = 'success' | 'partial' | 'all-failed' | 'idle';

export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly telegram: TelegramService;
  private readonly environment: string;
  private readonly now: () => number;

  private consecutiveFailedTicks = 0;
  private cooldownUntil: number | null = null;
  // Diagnostic: tracks the most recent failure reason for inclusion in
  // the alert body.
  private lastFailedSample:
    | { claimed: number; failed: number; lastError: string | null }
    | null = null;

  constructor(opts: AlertsServiceOptions) {
    this.threshold = Math.max(1, opts.threshold);
    this.cooldownMs = Math.max(0, opts.cooldownMs);
    this.telegram = opts.telegram;
    this.environment = opts.environment;
    this.now = opts.now ?? Date.now;
  }
  /**
   * Inspect a tick result, update the rolling counter, and fire a
   * Telegram alert if the threshold is reached and we're not in
   * cooldown. Best-effort; never throws.
   */
  async recordTickResult(tick: OutboundTickResult): Promise<void> {
    const outcome = this.classify(tick);
    switch (outcome) {
      case 'success':
        this.consecutiveFailedTicks = 0;
        this.cooldownUntil = null;
        this.lastFailedSample = null;
        return;
      case 'partial':
        // Some sent, some failed — counts as a reset. The Meta API
        // is at least partially working.
        this.consecutiveFailedTicks = 0;
        this.cooldownUntil = null;
        this.lastFailedSample = null;
        return;
      case 'idle':
        // Nothing claimed (empty outbox or all rows in backoff).
        // Don't reset on idle — a real outage looks like "claimed
        // and failed" not "no rows". Leave the counter alone.
        return;
      case 'all-failed':
        // Track a sample for the alert body.
        this.lastFailedSample = {
          claimed: tick.claimed,
          failed: tick.failed,
          // The tick struct doesn't carry per-row errors (the cron
          // keeps them in lastError per row). For the alert body we
          // surface the count + the fact that every claimed send
          // failed. The cron logs include the per-row lastError for
          // full forensics.
          lastError: null,
        };
        this.consecutiveFailedTicks += 1;
        break;
    }

    // Cooldown gate.
    if (this.cooldownUntil !== null && this.now() < this.cooldownUntil) {
      return;
    }

    if (this.consecutiveFailedTicks < this.threshold) {
      return;
    }

    // Fire!
    const text = this.buildAlertText(tick);
    const sent = await this.telegram.sendChannelMessage(text);
    if (sent) {
      this.logger.warn(
        `Fired Telegram systematic-failure alert: ` +
          `consecutiveFailedTicks=${this.consecutiveFailedTicks}, ` +
          `cooldownMs=${this.cooldownMs}`,
      );
    }
    // Set the cooldown either way — even if Telegram rejected the
    // message, we don't want to spam retries every 5s.
    this.cooldownUntil = this.now() + this.cooldownMs;
    // Reset the counter so the next streak has to climb again from
    // zero. Without this, the same streak would re-fire as soon as
    // the cooldown expires.
    this.consecutiveFailedTicks = 0;
  }

  /**
   * Exposed for tests + ops dashboards. Do not call from production
   * code — `recordTickResult` is the only mutator.
   */
  getStateForOps(): {
    consecutiveFailedTicks: number;
    cooldownRemainingMs: number;
  } {
    const remaining =
      this.cooldownUntil === null
        ? 0
        : Math.max(0, this.cooldownUntil - this.now());
    return {
      consecutiveFailedTicks: this.consecutiveFailedTicks,
      cooldownRemainingMs: remaining,
    };
  }

  // ---------------------------------------------------------------------

  private classify(tick: OutboundTickResult): AlertTickOutcome {
    if (tick.claimed === 0) return 'idle';
    if (tick.sent > 0) return tick.failed > 0 ? 'partial' : 'success';
    // tick.sent === 0 here.
    return 'all-failed';
  }

  private buildAlertText(tick: OutboundTickResult): string {
    const sample = this.lastFailedSample;
    const lines: string[] = [];
    lines.push(
      `🚨 *WhatsApp outbound — systematic failure* (${this.environment})`,
    );
    lines.push('');
    lines.push(
      `\`${this.consecutiveFailedTicks}\` consecutive cron ticks had ` +
        `every claimed send fail. ` +
        `(${this.threshold} is the threshold; cooldown ` +
        `${Math.round(this.cooldownMs / 1000)}s.)`,
    );
    lines.push('');
    lines.push(
      `*Latest tick:* claimed=${tick.claimed} sent=${tick.sent} ` +
        `failed=${tick.failed} (started ${tick.startedAt.toISOString()})`,
    );
    if (sample !== null) {
      lines.push(
        `*Sample failure:* ${sample.claimed} claimed → ${sample.failed} ` +
          `failed. Check the cron logs for per-row lastError.`,
      );
    }
    lines.push('');
    lines.push(`_Sent by ${this.telegram.botName}._`);
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export interface AlertsModuleOptions {
  botToken: string | undefined;
  channelId: string | undefined;
  botName: string;
  environment: string;
  threshold?: number;
  cooldownMs?: number;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => number;
}

/** Build a configured AlertsService for direct injection (tests bypass
 *  the module). Mirrors the production DI shape exactly. */
export function buildAlertsService(opts: AlertsModuleOptions): {
  alerts: AlertsService;
  telegram: TelegramService;
} {
  const telegram = new TelegramService({
    botToken: opts.botToken,
    channelId: opts.channelId,
    botName: opts.botName,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.apiBaseUrl !== undefined ? { apiBaseUrl: opts.apiBaseUrl } : {}),
  });
  const alerts = new AlertsService({
    threshold: opts.threshold ?? DEFAULT_TELEGRAM_ALERT_THRESHOLD,
    cooldownMs: opts.cooldownMs ?? DEFAULT_TELEGRAM_ALERT_COOLDOWN_MS,
    telegram,
    environment: opts.environment,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { alerts, telegram };
}

@Global()
@Module({
  providers: [
    {
      provide: TelegramService,
      useFactory: () =>
        new TelegramService({
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          channelId: process.env.TELEGRAM_CHANNEL_ID,
          botName:
            process.env.TELEGRAM_BOT_NAME?.trim() ||
            'ShadhilCRMAlertsBot',
        }),
    },
    {
      provide: AlertsService,
      useFactory: (telegram: TelegramService) =>
        new AlertsService({
          threshold: process.env.TELEGRAM_ALERT_THRESHOLD
            ? Number.parseInt(process.env.TELEGRAM_ALERT_THRESHOLD, 10)
            : DEFAULT_TELEGRAM_ALERT_THRESHOLD,
          cooldownMs: process.env.TELEGRAM_ALERT_COOLDOWN_MS
            ? Number.parseInt(process.env.TELEGRAM_ALERT_COOLDOWN_MS, 10)
            : DEFAULT_TELEGRAM_ALERT_COOLDOWN_MS,
          telegram,
          environment: process.env.NODE_ENV ?? 'development',
        }),
      inject: [TelegramService],
    },
  ],
  exports: [TelegramService, AlertsService],
})
export class AlertsModule {}
