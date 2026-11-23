// Fixed-window rate limit for upload grants, per user AND per project
// (2026-11-23).
//
// A grant is reusable for 600 seconds and the browser then uploads straight to
// the CDN with no server in the loop, so the moment a grant is issued is the only
// chance to apply a limit. Two counters guard it: one engineer cannot burn the
// project's allowance, and a project cannot flood the org with grants.
//
// Counted in Redis (shared across API replicas). The INCR and the EXPIRE are one
// Lua script, so a crash between them can never leave an immortal counter. The
// limiter FAILS CLOSED: if Redis is unreachable the grant is refused with a
// retryable error rather than silently waving everyone through.
import { Inject, Injectable, Logger } from '@nestjs/common';

import { RedisService } from '../redis/redis.module';
import { SITE_VIDEO_CONFIG, type SiteVideoConfig } from './site-video.config';
import { siteVideoError } from './site-video.errors';

const COUNT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('TTL', KEYS[1])}
`;

@Injectable()
export class SiteVideoRateLimiter {
  private readonly logger = new Logger(SiteVideoRateLimiter.name);

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(SITE_VIDEO_CONFIG) private readonly config: SiteVideoConfig,
  ) {}

  /** Count one grant request; throws VIDEO_UPLOAD_RATE_LIMITED when over either limit. */
  async consume(args: {
    organizationId: string;
    userId: string;
    projectId: string;
  }): Promise<void> {
    const { organizationId: org, userId, projectId } = args;
    const window = this.config.authWindowSeconds;
    const user = await this.bump(`sitevideo:auth:user:${org}:${userId}`, window);
    // A user already over their own limit must not also burn the project's
    // allowance, or one member could lock the rest of the project out.
    if (user.count > this.config.authPerUserLimit) {
      throw siteVideoError('VIDEO_UPLOAD_RATE_LIMITED', {
        scope: 'USER',
        retryAfterSeconds: user.ttl,
      });
    }
    const project = await this.bump(`sitevideo:auth:project:${org}:${projectId}`, window);
    if (project.count > this.config.authPerProjectLimit) {
      throw siteVideoError('VIDEO_UPLOAD_RATE_LIMITED', {
        scope: 'PROJECT',
        retryAfterSeconds: project.ttl,
      });
    }
  }

  private async bump(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }> {
    try {
      const out = (await this.redis.$client.eval(COUNT_SCRIPT, 1, key, String(windowSeconds))) as [
        number,
        number,
      ];
      return { count: Number(out[0]), ttl: Math.max(Number(out[1]), 1) };
    } catch (err) {
      this.logger.error(
        `[site-video] rate limiter unavailable (${key}): ${err instanceof Error ? err.message : String(err)} - refusing the grant`,
      );
      throw siteVideoError('STORAGE_UNAVAILABLE');
    }
  }
}
