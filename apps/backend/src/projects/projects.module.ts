// Projects module - CRUD on the Project registry (T-ProjectSwitch).
//
// The Project table is the real project registry; GET /api/projects feeds
// the sidebar switcher, POST/PATCH/DELETE are the admin-class management
// surface (owner-only delete enforced in the service).
import { Module } from '@nestjs/common';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}