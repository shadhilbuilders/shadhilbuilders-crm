// Users module - user-creation hierarchy (DECISION-CHANGELOG Round 17).
// POST /api/users  ADMIN → any role; MANAGER → staff in own team
// GET  /api/users  ADMIN → all; MANAGER → own team; staff → self
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

import { PublicLoginController } from './public-login.controller';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * ThrottlerModule (2026-11-21) is imported HERE, not globally: the only route
 * that uses it is the public login resolver on PublicLoginController, and a
 * global guard would silently apply limits to every other endpoint.
 */
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }])],
  controllers: [UsersController, PublicLoginController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
