// Invites module (2026-11-20).
//
// Registers both controllers:
//   * InvitesController        - JWT-guarded admin CRUD (`/invites`)
//   * InvitesPublicController  - @Public() preview + accept (`/public/invites`)
//
// No imports needed: PrismaService comes from the @Global() PrismaModule, and
// the credential writer + role hierarchy helpers are plain functions imported
// directly from the users module (read-only - nothing in users.service.ts is
// modified by this feature).
import { Module } from '@nestjs/common';

import { InvitesController } from './invites.controller';
import { InvitesPublicController } from './invites-public.controller';
import { InvitesService } from './invites.service';

@Module({
  controllers: [InvitesController, InvitesPublicController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
