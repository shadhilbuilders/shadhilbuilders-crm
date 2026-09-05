// T-S - placeholder-password gate middleware.
//
// Sits in front of the better-auth catch-all (which is mounted at
// /api/auth/*splat) and rejects sign-in for any email listed in
// packages/auth-client/placeholder-users.json. The list is committed
// to the repo and contains the 5 seed accounts from Plan §17 Input
// #5. Production deploys that don't run the seed have an empty
// list; the gate is a no-op.
//
// Why this exists as a Nest middleware (not a better-auth `hooks.before`):
// better-auth 1.7.2's `hooks.before` is declared in the type signature
// but the dispatcher in api/index.mjs only invokes `onRequestRateLimit`
// and plugin `.onRequest` - `hooks.before` is never called. The
// practical gate lives at the HTTP layer.
//
// Implementation note: the same `placeholder-users.json` is read by
// @shadhil/auth at boot. To avoid two reads on every request, we
// import the pre-built Set the package exposes for the test suite
// (the test build uses a __test__ export). For production we just
// re-read the file - it's small (~5 entries) and the parse is O(1).

import {
  Inject,
  Injectable,
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Request, Response } from 'express';

@Injectable()
export class PlaceholderGateMiddleware {
  private readonly logger = new Logger(PlaceholderGateMiddleware.name);
  private readonly emails: Set<string>;

  constructor() {
    this.emails = this.loadPlaceholderEmails();
  }

  use(req: Request, res: Response, next: () => void): void {
    // Match the sign-in endpoint. `req.url` is the splat-resolved
    // URL (just "/" when forRoutes('auth/*splat') matches), so it
    // can't be used for path detection. `req.originalUrl` is the
    // full URL as it arrived (e.g. '/api/auth/sign-in/email').
    const url = req.originalUrl ?? req.url ?? '';
    if (!url.includes('/sign-in/email')) {
      next();
      return;
    }
    // req.body is parsed by the JSON body parser (Nest global
    // ValidationPipe with the default Express body parser upstream).
    // It's `undefined` for GETs and may be missing if the client
    // didn't send a body. Guard both.
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
    if (email.length === 0) {
      // No email in body - let better-auth's own validator return 400.
      next();
      return;
    }
    if (!this.emails.has(email)) {
      // Not a placeholder - pass through to better-auth.
      next();
      return;
    }

    // T-S hit: block the sign-in.
    this.logger.warn(
      `T-S: blocked sign-in for placeholder user ${email}`,
    );
    res.status(403).json({
      error: 'placeholder_password_locked',
      message:
        'This account still uses a placeholder password. ' +
        'Set a real password via the admin console or your password manager before signing in.',
    });
  }

  private loadPlaceholderEmails(): Set<string> {
    try {
      // Compiled middleware lives at
      //   apps/backend/dist/auth/placeholder-gate.middleware.js
      // (so __dirname = /app/apps/backend/dist/auth/). The flag file
      // is at /app/packages/auth-client/placeholder-users.json, so
      // the path is ../../packages/auth-client/placeholder-users.json
      // relative to the source - but at RUNTIME we walk up from
      // /app/apps/backend/dist/auth/ to /app/ then into
      // packages/auth-client/. The exact number of `..` segments
      // depends on whether we're in the source tree (src/auth/)
      // or the dist tree (dist/auth/). The Dockerfile's runtime
      // path is the dist tree, so:
      //   dist/auth/ → ../.. (apps/backend/dist) → .. (apps/backend)
      //   → .. (apps) → packages/auth-client/placeholder-users.json
      // That's 4 `..` from dist/auth/. To stay correct under both
      // nest build and any future test runner, anchor on a known
      // marker file (package.json) and walk up.
      const path = require('node:path') as typeof import('node:path');
      const flagPath = this.findFlagFile(path);
      if (flagPath === null) {
        this.logger.warn(
          'T-S: placeholder-users.json not found anywhere; gate is a no-op',
        );
        return new Set();
      }
      const raw = readFileSync(flagPath, 'utf8');
      const parsed = JSON.parse(raw) as { emails?: unknown };
      if (!Array.isArray(parsed.emails)) {
        this.logger.warn(
          'placeholder-users.json has no emails array - T-S gate is a no-op',
        );
        return new Set();
      }
      return new Set(
        parsed.emails.filter((e): e is string => typeof e === 'string'),
      );
    } catch (err) {
      this.logger.warn(
        `T-S: failed to load placeholder-users.json (${err instanceof Error ? err.message : 'unknown'}); gate is a no-op`,
      );
      return new Set();
    }
  }

  /**
   * Walk up from __dirname looking for the first directory that
   * contains packages/auth-client/placeholder-users.json. Works
   * from both the source tree (src/auth/) and the dist tree
   * (dist/auth/).
   */
  private findFlagFile(path: typeof import('node:path')): string | null {
    const fs = require('node:fs') as typeof import('node:fs');
    let dir = __dirname;
    // Cap the walk at 8 levels - defensive against infinite loop
    // in degenerate test setups that mount __dirname oddly.
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(
        dir,
        'packages',
        'auth-client',
        'placeholder-users.json',
      );
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }
}

@Module({
  providers: [PlaceholderGateMiddleware],
  exports: [PlaceholderGateMiddleware],
})
export class PlaceholderGateModule implements NestModule {
  // Exported so main.ts can chain this BEFORE the better-auth
  // catch-all. Nest applies middlewares in the order they're
  // registered.
  configure(consumer: MiddlewareConsumer): void {
    // The placeholder gate runs before any auth catch-all mount.
    // Path note: Nest's `forRoutes('auth/*splat')` exposes `req.path`
    // as the splat part. For '/api/auth/sign-in/email' the splat
    // is 'sign-in/email'. We match '/sign-in/email' AND
    // '/api/auth/sign-in/email' AND '/auth/sign-in/email' to cover
    // both modes (the behavior was inconsistent during testing -
    // depends on whether the request came in before or after the
    // global prefix is applied).
    consumer
      .apply(PlaceholderGateMiddleware)
      .forRoutes('auth/*splat', 'auth/sign-in/email', '*/auth/*splat');
  }
}
