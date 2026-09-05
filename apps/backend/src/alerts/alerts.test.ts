// T-E2b - Telegram systematic-failure alert tests (unit, no DB).
//
// The cron's `recordTickResult` is best-effort and never throws. The
// state machine is pure: rolling counter + cooldown clock + Telegram
// service call. We drive the state machine with a stub
// `TelegramService` and a controllable clock; no real network, no DB.
//
// Coverage:
//   1. Disabled Telegram (missing token or channel id) → no send
//   2. 1 failed tick → no alert (below threshold)
//   3. 2 failed ticks → no alert (below threshold)
//   4. 3 failed ticks → alert fires
//   5. Success tick in the middle of a streak resets the counter
//   6. During cooldown after an alert, additional failed ticks do not
//      fire more alerts
//   7. After cooldown expires, a new streak can fire a second alert
//   8. "Idle" tick (claimed=0) does NOT reset the counter (an empty
//      outbox isn't evidence Meta is healthy)
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AlertsService,
  type AlertsServiceOptions,
  TelegramService,
} from './alerts.module';

import type { OutboundTickResult } from '../whatsapp/outbound.cron';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface StubTelegram {
  svc: TelegramService;
  send: ReturnType<typeof vi.fn>;
}

/** A TelegramService we can spy on without hitting the network.
 *  We bypass the constructor's env reads and just override sendChannelMessage. */
function makeStubTelegram(opts: {
  botName?: string;
  sendResult?: boolean;
} = {}): StubTelegram {
  const svc = Object.create(TelegramService.prototype) as TelegramService;
  (svc as unknown as { enabled: boolean }).enabled = true;
  (svc as unknown as { botName: string }).botName = opts.botName ?? 'TestBot';
  const send = vi.fn(async (_text: string) => opts.sendResult ?? true);
  (svc as unknown as { sendChannelMessage: typeof send }).sendChannelMessage =
    send;
  return { svc, send };
}

function makeTick(overrides: Partial<OutboundTickResult> = {}): OutboundTickResult {
  return {
    startedAt: new Date('2026-09-05T10:00:00Z'),
    finishedAt: new Date('2026-09-05T10:00:01Z'),
    lockHeld: true,
    claimed: 0,
    sent: 0,
    failed: 0,
    skippedBackoff: 0,
    ...overrides,
  };
}

interface AlertsCtx {
  alerts: AlertsService;
  send: ReturnType<typeof vi.fn>;
  now: () => number;
  advance: (ms: number) => void;
}

function makeAlerts(opts: {
  threshold?: number;
  cooldownMs?: number;
  now?: () => number;
  telegram?: TelegramService;
  environment?: string;
}): AlertsCtx {
  let currentTime = 1_700_000_000_000;
  const advance = (ms: number) => {
    currentTime += ms;
  };
  const now = opts.now ?? (() => currentTime);
  const stub = opts.telegram !== undefined
    ? { svc: opts.telegram, send: vi.fn(async () => true) as ReturnType<typeof vi.fn> }
    : makeStubTelegram();
  const cfg: AlertsServiceOptions = {
    threshold: opts.threshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 15 * 60 * 1000,
    telegram: stub.svc,
    environment: opts.environment ?? 'test',
    now,
  };
  return {
    alerts: new AlertsService(cfg),
    send: stub.send,
    now,
    advance,
  };
}

// ---------------------------------------------------------------------------
// TelegramService constructor behaviour - disabled when creds missing
// ---------------------------------------------------------------------------

describe('TelegramService - enabled gate', () => {
  it('is disabled when botToken is missing → sendChannelMessage is a no-op', async () => {
    const svc = new TelegramService({
      botToken: undefined,
      channelId: '-100123',
      botName: 'TestBot',
    });
    const fetchSpy = vi.fn();
    (svc as unknown as { fetchImpl: typeof fetch }).fetchImpl =
      fetchSpy as unknown as typeof fetch;
    const result = await svc.sendChannelMessage('hello');
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is disabled when channelId is missing → sendChannelMessage is a no-op', async () => {
    const svc = new TelegramService({
      botToken: 'abc',
      channelId: undefined,
      botName: 'TestBot',
    });
    const fetchSpy = vi.fn();
    (svc as unknown as { fetchImpl: typeof fetch }).fetchImpl =
      fetchSpy as unknown as typeof fetch;
    const result = await svc.sendChannelMessage('hello');
    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends to the Bot API when enabled (POST sendMessage)', async () => {
    const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.telegram.org/botTOKEN/sendMessage');
      const body = JSON.parse(init.body as string);
      expect(body.chat_id).toBe('-100123');
      expect(body.text).toContain('hello');
      expect(body.parse_mode).toBe('Markdown');
      return new Response('{"ok":true}', { status: 200 });
    });
    const svc = new TelegramService({
      botToken: 'TOKEN',
      channelId: '-100123',
      botName: 'TestBot',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const result = await svc.sendChannelMessage('hello');
    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns false (does NOT throw) when fetch throws', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const svc = new TelegramService({
      botToken: 'TOKEN',
      channelId: '-100123',
      botName: 'TestBot',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const result = await svc.sendChannelMessage('hello');
    expect(result).toBe(false);
  });

  it('returns false when Telegram responds with a non-2xx status', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response('{"ok":false,"description":"chat not found"}', {
        status: 400,
      }),
    );
    const svc = new TelegramService({
      botToken: 'TOKEN',
      channelId: '-100123',
      botName: 'TestBot',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const result = await svc.sendChannelMessage('hello');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AlertsService - rolling counter + cooldown
// ---------------------------------------------------------------------------

describe('AlertsService - systematic-failure detection (T-E2b)', () => {
  let nowTime: number;
  let advance: (ms: number) => void;
  let alerts: AlertsService;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nowTime = 1_700_000_000_000;
    advance = (ms) => {
      nowTime += ms;
    };
  });

  it('1 failed tick does NOT fire an alert (below threshold)', async () => {
    const ctx = makeAlerts({ threshold: 3, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));

    expect(send).not.toHaveBeenCalled();
  });

  it('2 failed ticks do NOT fire an alert (still below threshold)', async () => {
    const ctx = makeAlerts({ threshold: 3, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 2, sent: 0, failed: 2 }));

    expect(send).not.toHaveBeenCalled();
  });

  it('3 consecutive failed ticks fire one alert', async () => {
    const ctx = makeAlerts({ threshold: 3, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    for (let i = 0; i < 3; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    }

    expect(send).toHaveBeenCalledTimes(1);
    const text = send.mock.calls[0]?.[0] as string;
    expect(text).toContain('systematic failure');
    // The counter is rendered as Markdown backticks (`3`), so the
    // exact substring is `3\` consecutive` - assert the meaningful
    // portion without the formatting.
    expect(text).toContain('consecutive cron ticks');
  });

  it('a success tick in the middle of a failed streak resets the counter', async () => {
    const ctx = makeAlerts({ threshold: 3, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    // 2 failed ticks (counter at 2).
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));

    // 1 success tick - counter resets.
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 1, failed: 0 }));

    // Now 2 more failed ticks (counter back at 2 - below threshold).
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));

    expect(send).not.toHaveBeenCalled();
  });

  it('during cooldown after an alert, additional failed ticks do NOT fire more alerts', async () => {
    const ctx = makeAlerts({ threshold: 3, cooldownMs: 60_000, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    // First streak: 3 fails → alert fires.
    for (let i = 0; i < 3; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    }
    expect(send).toHaveBeenCalledTimes(1);

    // 10 more failed ticks during cooldown.
    for (let i = 0; i < 10; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    }

    // Still exactly 1 alert - cooldown suppressed the rest.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('after cooldown expires, a new failed streak can fire a second alert', async () => {
    const ctx = makeAlerts({ threshold: 3, cooldownMs: 60_000, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    // First streak: 3 fails → alert.
    for (let i = 0; i < 3; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    }
    expect(send).toHaveBeenCalledTimes(1);

    // Advance past cooldown (61s > 60s).
    advance(61_000);

    // Second streak: 3 more fails → second alert.
    for (let i = 0; i < 3; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    }
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('an idle tick (claimed=0) does NOT reset the counter', async () => {
    const ctx = makeAlerts({ threshold: 3, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    // 2 failed ticks.
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 2, sent: 0, failed: 2 }));

    // 5 idle ticks (empty outbox). They MUST NOT reset.
    for (let i = 0; i < 5; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 0 }));
    }

    // 1 more failed tick → counter at 3 → alert.
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a partial tick (sent > 0 AND failed > 0) DOES reset the counter', async () => {
    const ctx = makeAlerts({ threshold: 3, now: () => nowTime });
    alerts = ctx.alerts;
    send = ctx.send;

    // 2 failed ticks (counter at 2).
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));

    // 1 partial tick - some sent, some failed. Counter resets.
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 2, sent: 1, failed: 1 }));

    // 2 more failed ticks - counter only at 2, below threshold.
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));

    expect(send).not.toHaveBeenCalled();
  });

  it('Telegram send failure still sets the cooldown (no retry storm)', async () => {
    // Simulate Telegram being unreachable: sendChannelMessage returns
    // false. The cooldown must still start so we don't keep hammering
    // Telegram every 5s during a real outage.
    const broken = makeStubTelegram({ sendResult: false });
    const ctx = makeAlerts({
      threshold: 3,
      cooldownMs: 60_000,
      now: () => nowTime,
      telegram: broken.svc,
    });
    alerts = ctx.alerts;
    send = broken.send;

    // First streak → tries to send → fails → cooldown is set.
    for (let i = 0; i < 3; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    }
    expect(send).toHaveBeenCalledTimes(1);

    // 10 more failed ticks during the cooldown - Telegram NOT called again.
    for (let i = 0; i < 10; i++) {
      advance(5_000);
      await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('getStateForOps reports the current counter + cooldown', async () => {
    const ctx = makeAlerts({ threshold: 3, cooldownMs: 60_000, now: () => nowTime });
    alerts = ctx.alerts;

    expect(alerts.getStateForOps().consecutiveFailedTicks).toBe(0);
    expect(alerts.getStateForOps().cooldownRemainingMs).toBe(0);

    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    expect(alerts.getStateForOps().consecutiveFailedTicks).toBe(1);

    // Fire the alert (3rd consecutive failure).
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));
    advance(5_000);
    await alerts.recordTickResult(makeTick({ claimed: 1, sent: 0, failed: 1 }));

    // After the alert, the counter is reset but cooldown is set.
    const state = alerts.getStateForOps();
    expect(state.consecutiveFailedTicks).toBe(0);
    expect(state.cooldownRemainingMs).toBeGreaterThan(0);
    expect(state.cooldownRemainingMs).toBeLessThanOrEqual(60_000);
  });
});
