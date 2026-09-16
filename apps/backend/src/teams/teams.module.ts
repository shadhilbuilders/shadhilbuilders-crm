// Teams module - list teams the current user is a member of.
//
// Driven by the sidebar-07 layout (T-Sidebar07, 2026-09-05). The
// sidebar's <TeamSwitcher> consumes this list to show the user's
// teams in a dropdown. The endpoint is intentionally minimal: it
// returns id + name + (optional) defaultAssigneeId + memberCount,
// scoped to the current user via the withRlsContext pattern.
//
// There is no "current team" scalar: membership is TeamMember
// (many-to-many) plus Team.managerId. Clients that need a team
// picker call GET /api/teams.

import { Module } from '@nestjs/common';

import { ProjectTeamsController } from './project-teams.controller';
import { ProjectTeamsService } from './project-teams.service';
import { TeamAccessService } from './team-access.service';
import { TeamMembersController } from './team-members.controller';
import { TeamMembersService } from './team-members.service';
import { TeamsController } from './teams.controller';
import { TeamsService } from './teams.service';

@Module({
  controllers: [TeamsController, ProjectTeamsController, TeamMembersController],
  providers: [TeamsService, TeamAccessService, ProjectTeamsService, TeamMembersService],
  exports: [TeamsService, TeamAccessService, ProjectTeamsService, TeamMembersService],
})
export class TeamsModule {}
