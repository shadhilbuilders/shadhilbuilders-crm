// JWT auth guard — global, with @Public() opt-out.
//
// Phase 1 wiring: verifies the JWT in `Authorization: Bearer ...` and
// resolves the JwtPayload onto request.user. Per-request RLS session vars
// (app.user_id, app.user_role, app.user_team_id) are set inside the
// controller's RlsInterceptor (see rls.interceptor.ts).
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtPayload, verifyJwt } from '@shadhil/auth';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './public.decorator';

export type AuthedRequest = Request & { user?: JwtPayload };

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
    try {
      const payload = await verifyJwt(token);
      req.user = payload;
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown';
      throw new UnauthorizedException(`Invalid token: ${reason}`);
    }
  }
}
