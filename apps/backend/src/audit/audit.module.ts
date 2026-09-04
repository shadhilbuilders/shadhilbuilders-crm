// Audit module — filterable audit log list (READ ONLY).
//
// T-AUDIT (2026-09-07): replaces the Phase-1 stub. The audit rows
// themselves are written by every other module as a side effect of
// their mutations (per eng-review A2: audit writes MUST be
// transactional with the triggering action). This module ONLY
// READS — no creation endpoint.
//
// The page wiring (apps/web/src/hooks/queries/crm.ts) calls
// useAuditLog — it lights up against this module's GET endpoint.
import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
