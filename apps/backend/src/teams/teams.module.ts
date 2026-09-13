// Teams module - list teams the current user is a member of.
//
// Driven by the sidebar-07 layout (T-Sidebar07, 2026-09-05). The
// sidebar's <TeamSwitcher> consumes this list to show the user's
// teams in a dropdown. The endpoint is intentionally minimal: it
// returns id + name + (optional) defaultAssigneeId + memberCount,
// scoped to the current user via the withRlsContext pattern.
//
// Why we DON'T return a "current team" field:
//   The User model has teamId (one team per user). When multi-team
//   membership lands (User <-> Team many-to-many), the data model
//   changes and so does this endpoint. Until then, the user's
//   "active team" is the team they were created with, derived on the
//   client from useSessionUser().teamId.

import { Module } from '@nestjs/common';

import { ProjectTeamsController } from './project-teams.controller';
import { ProjectTeamsService } from './project-teams.service';
import { TeamAccessService } from './team-access.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

@Module({
  controllers: [TeamsController, ProjectTeamsController],
  providers: [TeamsService, TeamAccessService, ProjectTeamsService],
  exports: [TeamsService, TeamAccessService, ProjectTeamsService],
})
export class TeamsModule {}
