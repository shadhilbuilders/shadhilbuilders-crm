// SiteVideoRateLimiter (site update video, step 5).
// protects= grants are limited per user AND per project, the window is set by
// one atomic script, and an unreachable Redis refuses rather than allows.
// fails_when= either counter is skipped, the TTL can be missed, or Redis down
// means unlimited grants.
import { describe, expect, it, vi } from 'vitest';

import { SiteVideoRateLimiter } from './site-video-rate-limiter';
import type { SiteVideoConfig } from './site-video.config';

const CONFIG: SiteVideoConfig = {
  enabled: true,
  orgCapBytes: 1,
  projectCapBytes: 1,
  authPerUserLimit: 2,
  authPerProjectLimit: 3,
  authWindowSeconds: 600,
};
const args = { organizationId: 'o', userId: 'u', projectId: 'p' };

function limiter(counts: Record<string, number>, fail = false) {
  const eval_ = vi.fn(async (_script: string, _n: number, key: string) => {
    if (fail) throw new Error('ECONNREFUSED');
    counts[key] = (counts[key] ?? 0) + 1;
    return [counts[key], 120];
  });
  const redis = { $client: { eval: eval_ } };
  return { svc: new SiteVideoRateLimiter(redis as never, CONFIG), eval_ };
}

describe('SiteVideoRateLimiter', () => {
  it('allows requests up to each limit', async () => {
    const { svc } = limiter({});
    await svc.consume(args);
    await svc.consume(args);
  });

  it('refuses the request over the per-user limit and says which scope', async () => {
    const { svc } = limiter({});
    await svc.consume(args);
    await svc.consume(args);
    await expect(svc.consume(args)).rejects.toMatchObject({
      response: {
        code: 'VIDEO_UPLOAD_RATE_LIMITED',
        retryable: true,
        details: { scope: 'USER', retryAfterSeconds: 120 },
      },
    });
  });

  it('refuses over the per-project limit even when each user is under theirs', async () => {
    const { svc } = limiter({});
    for (const userId of ['a', 'b', 'c']) await svc.consume({ ...args, userId });
    await expect(svc.consume({ ...args, userId: 'd' })).rejects.toMatchObject({
      response: { details: { scope: 'PROJECT' } },
    });
  });

  it('a user already over their limit does not burn the project allowance', async () => {
    const counts: Record<string, number> = {};
    const { svc } = limiter(counts);
    await svc.consume(args);
    await svc.consume(args);
    for (let i = 0; i < 5; i += 1) await svc.consume(args).catch(() => undefined);
    expect(counts['sitevideo:auth:project:o:p']).toBe(2);
  });

  it('keeps users, projects and organisations in separate counters', async () => {
    const counts: Record<string, number> = {};
    const { svc } = limiter(counts);
    await svc.consume(args);
    await svc.consume({ ...args, organizationId: 'o2' });
    await svc.consume({ ...args, userId: 'u2' });
    expect(Object.keys(counts)).toHaveLength(5);
  });

  it('sets the window through the one atomic script', async () => {
    const { svc, eval_ } = limiter({});
    await svc.consume(args);
    const [script, , , window] = eval_.mock.calls[0] as unknown as [string, number, string, string];
    expect(script).toContain("redis.call('INCR'");
    expect(script).toContain("redis.call('EXPIRE'");
    expect(window).toBe('600');
  });

  it('FAILS CLOSED with a retryable error when Redis is unreachable', async () => {
    const { svc } = limiter({}, true);
    await expect(svc.consume(args)).rejects.toMatchObject({
      response: { code: 'STORAGE_UNAVAILABLE', retryable: true },
    });
  });
});
