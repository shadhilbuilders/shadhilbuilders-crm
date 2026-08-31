// Wire better-auth catch-all as Express middleware. Mounted at /api/auth/*
// so Meta's webhook verification (GET), sign-in (POST), and other better-auth
// endpoints all work without duplicating the better-auth instance per framework.
import { Inject, Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthModule } from './auth.module';

@Module({
  imports: [AuthModule], // exports BETTER_AUTH_HANDLER
})
export class BetterAuthMiddlewareModule implements NestModule {
  private readonly logger = new Logger(BetterAuthMiddlewareModule.name);

  constructor(@Inject('BETTER_AUTH_HANDLER') private readonly handler: unknown) {
    this.logger.log('better-auth catch-all mounted at /api/auth/*');
  }

  configure(consumer: MiddlewareConsumer): void {
    // Nest 12 / path-to-regexp v8: bare 'auth/*' no longer matches deep
    // segments (sign-in/email, get-session, token...). Wildcards must be
    // named: 'auth/*splat'. This was why POST /api/auth/sign-in/email 404'd
    // with "Cannot POST" while GET /api/auth/ok (Nest controller) worked.
    consumer.apply(this.handler as never).forRoutes('auth/*splat');
  }
}
