// Inventory module - villa/unit availability grid (DESIGN.md module 4).
// Wires the controller + service. InventoryService is exported so other
// modules (bookings) could drive unit status changes if needed.
import { Module } from '@nestjs/common';

import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { UnitAssignmentService } from './unit-assignment.service';

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, UnitAssignmentService],
  exports: [InventoryService],
})
export class InventoryModule {}
