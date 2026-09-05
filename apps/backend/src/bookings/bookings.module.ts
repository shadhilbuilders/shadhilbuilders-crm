// Bookings module - booking lifecycle (HOLD → TOKEN → APPROVED/etc.).
//
// T-BOOK (2026-09-07): replaces the Phase-1 stub. BookingsService
// doesn't depend on LeadsService today (booking creation/transition
// doesn't drive lead state changes in Phase 1), so no LeadsModule
// import is needed. If T-BOOK ever needs to drive a lead state
// transition (e.g. WON on approval), add LeadsModule to imports and
// @Inject(LeadsService) on the service constructor.
import { Module } from '@nestjs/common';

import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';

@Module({
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
