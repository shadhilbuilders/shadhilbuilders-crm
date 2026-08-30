// Wire better-auth catch-all as Express middleware. Mounted at /api/auth/*
// so Meta's webhook verification (GET), sign-in (POST), and other better-auth
// endpoints all work without duplicating the better-auth instance per framework.
import { Inject, Logger, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

@Module({})
export class BetterAuthMiddlewareModule implements NestModule {
  private readonly logger = new Logger(BetterAuthMiddlewareModule.name);

  constructor(@Inject('BETTER_AUTH_HANDLER') private readonly handler: unknown) {
    this.logger.log('better-auth catch-all mounted at /api/auth/*');
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(this.handler as never).forRoutes('auth/*');
  }
}
