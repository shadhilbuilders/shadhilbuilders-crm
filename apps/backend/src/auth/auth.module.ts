// Auth module — exposes the better-auth catch-all + helper route for
// issuing JWTs. The actual better-auth handlers live in @shadhil/auth.
import { Controller, Get, Module, Req } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { toNodeHandler } from 'better-auth/node';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { jwt } from 'better-auth/plugins/jwt';
import { admin } from 'better-auth/plugins/admin';
import { prisma } from '@shadhil/database';
import { Public } from './public.decorator';

// `auth` is typed as `any` (the structural Auth<T> is deeply parameterized
// and reaches into zod/better-auth internals — same pattern as @shadhil/auth).
function makeAuth(): any {
  return betterAuth({
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    emailAndPassword: { enabled: true },
    plugins: [jwt({ jwt: { issuer: 'shadhil-crm' } }), admin()],
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL: process.env.BETTER_AUTH_URL,
  });
}

@Controller('auth')
class AuthController {
  // Proxy GET /api/auth/* and POST /api/auth/* to better-auth.
  // Phase 1: minimal — the heavy lifting (signup/signin flows) lands Week 3.
  @Public()
  @Get('ok')
  ok(): { status: 'ok' } {
    return { status: 'ok' };
  }
}

const auth: any = makeAuth();
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
