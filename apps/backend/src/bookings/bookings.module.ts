// Booking lifecycle + manager approval flow.
import { Controller, Get, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

@ApiTags('bookings')
@ApiBearerAuth('jwt')
@Controller('bookings')
class BookingsController {
  @Get()
  list(): { message: string; phase: number } {
    return { message: 'Booking lifecycle lands in Week 7', phase: 1 };
  }
}

@Module({ controllers: [BookingsController] })
export class BookingsModule {}
