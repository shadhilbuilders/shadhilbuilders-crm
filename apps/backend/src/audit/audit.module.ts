// Audit log module — every controller action is logged here.
//
// Eng review A2: audit writes MUST be transactional (prisma.$transaction).
// High-stakes actions (reassign, state transitions) accept a `tx` client
// and write their audit row inside the same transaction. Lower-stakes
// actions use the AuditInterceptor (TODO: Phase 2) which falls back to a
// fresh transaction.
//
// Read API: /api/audit?userId=...&entityType=...&from=...&to=...
import { Controller, Get, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditLogQueryDto } from '@shadhil/api-types';

@ApiTags('audit')
@ApiBearerAuth('jwt')
@Controller('audit')
class AuditController {
  @Get()
  query(@Query() _q: AuditLogQueryDto): { message: string; phase: number } {
    return { message: 'Audit query lands in Week 9', phase: 1 };
  }
}

@Module({ controllers: [AuditController] })
export class AuditModule {}
