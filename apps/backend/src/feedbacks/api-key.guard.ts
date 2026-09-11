// Public API-key guard - authenticates the anonymous feedback endpoint.
//
// POST /api/public/feedback is reachable by the landing page (a server, not
// a browser with a JWT), so the standard JwtAuthGuard with @Public() opts it
// out of JWT auth and this guard instead validates the `x-api-key` header
// against the FEEDBACK_API_KEY env var.
//
// Security notes:
//   - Constant-time compare (crypto.timingSafeEqual) so a timing side
//     channel can't be used to probe the key byte-by-byte.
//   - The key is REQUIRED at boot: boot-env.ts fails startup if
//     FEEDBACK_API_KEY is missing (T-G8 fail-fast), so this guard never
//     compares against a blank default that would accept empty keys.
//   - This guard only protects the @Public() feedback route; every other
//     route still goes through the global JwtAuthGuard. A future public
//     endpoint with a different key must use its own guard (keys are not
//     shared - see boot-env FEEDBACK_API_KEY comment).
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
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-api-key'];
    const provided = Array.isArray(header) ? header[0] : header;

    const expected = process.env['FEEDBACK_API_KEY'];
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
