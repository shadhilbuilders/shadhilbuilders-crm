// Redis client module. Used for:
//  - SSE pub/sub (eng review A9: per-channel event broadcast)
//  - @Cron locks (eng review A3: SET NX EX 50 to prevent double-fire)
//  - rate limiting (per-request quotas)
import { Global, Module, OnModuleDestroy, Logger } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

class RedisService implements OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor() {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    this.client.on('error', (err: Error) => {
      this.logger.error(`Redis error: ${err.message}`);
    });
  }

  get $client(): Redis {
    return this.client;
  }

  /**
   * Try to acquire a lock with TTL. Returns the lock token (use it for safe
   * release) or null if the lock is already held.
   *
   * Eng review A3: every @Cron job uses this to ensure only one NestJS
   * replica processes the per-minute tick.
   */
  async acquireLock(
    key: string,
    ttlSec: number,
    token: string,
  ): Promise<boolean> {
    const result = await this.client.set(key, token, 'EX', ttlSec, 'NX');
    return result === 'OK';
  }

  /**
   * Release a lock only if we still own it. Uses a Lua script for atomicity.
   */
  async releaseLock(key: string, token: string): Promise<void> {
    const lua = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.client.eval(lua, 1, key, token);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}

@Global()
@Module({
  providers: [{ provide: RedisService, useClass: RedisService }],
  exports: [RedisService],
})
export class RedisModule {}
