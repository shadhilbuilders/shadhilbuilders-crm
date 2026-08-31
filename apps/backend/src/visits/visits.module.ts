// Site visit scheduling + outcomes module.
import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('visits')
@ApiBearerAuth('jwt')
@Controller('visits')
class VisitsController {
  @Get()
  list(): { message: string; phase: number } {
    return { message: 'Visit CRUD lands in Week 5', phase: 1 };
  }
}

@Module({ controllers: [VisitsController] })
export class VisitsModule {}
