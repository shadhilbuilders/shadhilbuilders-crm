// Auth module - proxies better-auth handlers to the SHARED instance in
// @shadhil/auth (SECOND-ROUND AUDIT AR-8: backend previously built a second
// betterAuth() that skipped assertAuthEnv and could drift config from the
// web side. Single source of truth now).
import { Controller, Get, Module } from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '@shadhil/auth';
import { Public } from './public.decorator';

@Controller('auth')
class AuthController {
  // Phase 1: minimal - the heavy lifting (signup/signin flows) lands Week 3.
  @Public()
  @Get('ok')
  ok(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

const authHandler = toNodeHandler(auth.handler as never);

@Module({
  controllers: [AuthController],
  // Export the Express middleware as a Nest provider so the auth catch-all
  // can be mounted in main.ts.
  providers: [
    {
      provide: 'BETTER_AUTH_HANDLER',
      useValue: authHandler,
    },
  ],
  exports: ['BETTER_AUTH_HANDLER'],
})
export class AuthModule {}