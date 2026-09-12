// Public API-key guard - authenticates anonymous public endpoints (feedback,
// leads) that the landing page calls (a server, not a browser with a JWT).
// The standard JwtAuthGuard with @Public() opts them out of JWT auth and
// this guard validates the `x-api-key` header against a configured env var.
//
// Usage: BOTH public endpoints share ONE key (PUBLIC_API_KEY) for simple,
// consistent config:
//   - feedback:  @UseGuards(new ApiKeyGuard('PUBLIC_API_KEY'))
//   - leads:      @UseGuards(new ApiKeyGuard('PUBLIC_API_KEY'))
//
// Security notes:
//   - Constant-time compare (crypto.timingSafeEqual) so a timing side
//     channel can't be used to probe the key byte-by-byte.
//   - The key is REQUIRED at boot: boot-env.ts fails startup if the env var
//     is missing (T-G8 fail-fast), so this guard never compares against a
//     blank default that would accept empty keys.
//   - This guard only protects the @Public() routes; every other route still
//     goes through the global JwtAuthGuard.
//   - An env var name is passed at construction (not read from the class)
//     so one guard serves every public endpoint without a switch statement.
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly envVar: string) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;

    const expected = process.env[this.envVar];
    if (expected === undefined || expected === '') {
      // Unreachable via boot-env fail-fast; kept as a defensive fail-closed.
      throw new UnauthorizedException('API key auth is not configured');
    }

    if (typeof provided !== 'string' || provided.length === 0) {
      throw new UnauthorizedException('Missing x-api-key header');
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on length mismatch, so pad both to the longer
    // side and compare the padded buffers (length mismatch still fails).
    const max = Math.max(a.length, b.length);
    const len =
      a.length === b.length
        ? b
        : Buffer.concat([a, Buffer.alloc(max - a.length)], max);
    const expectedPadded =
      a.length === b.length
        ? a
        : Buffer.concat([b, Buffer.alloc(max - b.length)], max);

    const ok = timingSafeEqual(len, expectedPadded) && a.length === b.length;
    if (!ok) {
      throw new UnauthorizedException('Invalid x-api-key');
    }
    return true;
  }
}
// Backward-compatible alias: feedback uses PUBLIC_API_KEY (shared key).
export class FeedbackApiKeyGuard extends ApiKeyGuard {
  constructor() {
    super('PUBLIC_API_KEY');
  }
}
