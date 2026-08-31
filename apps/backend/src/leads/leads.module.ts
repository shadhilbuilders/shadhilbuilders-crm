// Lead CRUD + state machine + reassignment module.
// Phase 1 scaffold — controllers/services registered but business logic
// lands in Week 4 (Lead CRUD + Lead Inbox).
import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('leads')
@ApiBearerAuth('jwt')
@Controller('leads')
class LeadsController {
  @Get()
  list(): { message: string; phase: number } {
    return { message: 'Lead CRUD lands in Week 4', phase: 1 };
  }
}

@Module({ controllers: [LeadsController] })
export class LeadsModule {}
