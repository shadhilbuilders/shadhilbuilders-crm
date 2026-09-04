// JWT auth guard — global, with @Public() opt-out.
//
// Phase 1 wiring: verifies the JWT in `Authorization: Bearer *** and
// resolves the JwtPayload onto request.user. Per-request RLS session vars
// (app.user_id, app.user_role, app.user_team_id) are set inside the
// controller's RlsInterceptor (see rls.interceptor.ts).
//
// T-S hardening (2026-09-04, Week 5):
//   After JWT verify, look up User.mustChangePassword. When true, reject
//   the request with a 403 + PASSWORD_CHANGE_REQUIRED code that the
//   web BFF can intercept and route to /change-password.
//
// Trade-off (intentional, documented):
//   We do a DB lookup per authenticated request. The "cache the flag on
//   the JWT at mint time" alternative is rejected because:
//     - It widens the surface — every JWT issuer (better-auth's jwt()
//       plugin, the BFF's issueJwt()) would need to add the claim.
//     - It loses liveness — an admin who resets a password can't unlock
//       a stale-session user until their JWT expires.
//   The DB hit is one indexed PK lookup on the bare prisma client
//   (~0.5ms p50 on the dev Postgres). If this shows up in a p99
//   trace, the right fix is a 5-10s in-memory cache keyed on userId
//   (re-check after every successful password change so the user
//   doesn't see the gate fire AFTER they rotated).
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload, verifyJwt } from '@shadhil/auth';
import { prisma as sharedPrisma } from '@shadhil/database';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';

export type AuthedRequest = Request & { user?: JwtPayload };

/**
 * T-S hardening: structured response shape the web BFF intercepts.
 * The BFF recognizes the 403 status + code + redirect and routes the
 * browser to /change-password (which renders the form). The redirect
 * URL is absolute (same-origin) so the BFF doesn't have to construct
 * it; the path lives in the JSON body for clarity.
 */
export interface PasswordChangeRequiredError {
  code: 'PASSWORD_CHANGE_REQUIRED';
  message: string;
  redirect: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = auth.slice(7).trim();
    let payload: JwtPayload;
    try {
      payload = await verifyJwt(token);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      throw new UnauthorizedException(`Invalid token: ${reason}`);
    }
    req.user = payload;

    // T-S hardening: enforce the mustChangePassword gate. The shared
    // prisma client connects on DATABASE_URL (the non-owner app role);
    // SELECT on the User row succeeds because User has no FORCE RLS
    // (auth tables are pre-RLS by design — see policies.sql comments).
    const user = await sharedPrisma.user.findUnique({
      where: { id: payload.sub },
      select: { mustChangePassword: true },
    });
    if (user?.mustChangePassword === true) {
      throw new HttpException(
        {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message:
            'You must change your password before accessing this resource',
          redirect: '/change-password',
        },
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
