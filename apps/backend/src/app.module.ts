// NestJS 12 (locked per plan §1) — REST API for Shadhil Builders CRM.
// Phase 1 scaffold: 9 modules wired with RLS context, JWT auth, OpenAPI docs.
import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { AuthModule } from './auth/auth.module';
import { BetterAuthMiddlewareModule } from './auth/better-auth.middleware';
import { PlaceholderGateModule } from './auth/placeholder-gate.middleware';
import { UsersModule } from './users/users.module';
import { LeadsModule } from './leads/leads.module';
import { VisitsModule } from './visits/visits.module';
import { ChatModule } from './chat/chat.module';
import { BookingsModule } from './bookings/bookings.module';
import { RemindersModule } from './reminders/reminders.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditModule } from './audit/audit.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { RealtimeModule } from './realtime/realtime.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    // Infrastructure
    PrismaModule,
    RedisModule,
    HealthModule,

    // Feature modules (9 per plan §2 + users)
    AuthModule,
    UsersModule,
    // T-S: PlaceholderGateModule must come BEFORE BetterAuthMiddlewareModule
    // so its middleware fires first (Nest applies module middlewares in
    // the order modules appear in `imports`). The gate rejects sign-in
    // for placeholder emails before better-auth sees the request.
    PlaceholderGateModule,
    BetterAuthMiddlewareModule,
    LeadsModule,
    VisitsModule,
    ChatModule,
    BookingsModule,
    RemindersModule,
    NotificationsModule,
    AuditModule,
    WebhooksModule,

    // Realtime (SSE — eng review A9: Last-Event-ID resume)
    RealtimeModule,
  ],
  providers: [
    // Default-deny: every route needs a valid JWT unless @Public() is set.
    // Phase 1 keeps most routes @Public() — login flow lands in Week 3.
    //
    // useFactory + inject: workaround for nestjs/nest#2130 where
    // useClass for global guards occasionally leaves constructor-injected
    // deps (here: Reflector) undefined at request time. Explicit inject
    // forces the DI container to resolve Reflector before calling the
    // factory.
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector),
      inject: [Reflector],
    },
  ],
})
export class AppModule {}
