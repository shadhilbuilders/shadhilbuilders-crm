'use client';

// Overview SectionCards - the /overview command center's KPI cards.
//
// Redesign (2026-09-10): replaces the plain KpiStrip with shadcn-style
// stat cards - each KPI is a Card with a description label, a large
// tabular-nums value, a Badge action, and a footer line. Wired to REAL
// data from GET /api/dashboard/overview (no fabricated numbers).
//
// Data-confidence honesty (CEO F3): the overview endpoint returns counts
// only - it does NOT compute period-over-period deltas. So the Badge shows
// a real, meaningful qualifier (e.g. "all teams", "ownership changes")
// instead of an invented "+12.5%" trend. The trending icons are decorative
// visual flourishes, not fabricated percentages.
import {
  Badge,
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@paalstack/react-ui';
import { LuActivity, LuTrendingUp, LuUsersRound } from '@paalstack/react-icons/lu';

import type { DashboardOverviewStats } from '@shadhil/api-types';
import { numberIntl } from '@/lib/format';
import { labelFor } from '@/lib/labels';

export type OverviewSectionCardsProps = {
  overview: DashboardOverviewStats;
};

/**
 * Renders the four KPI cards for the /overview command center. Each card
 * reads a real aggregate from the overview payload. The `usersByRole`
 * card shows the total user count with a role breakdown in the footer.
 */
export function OverviewSectionCards({ overview }: OverviewSectionCardsProps) {
  const { kpis } = overview;
  const totalUsers = kpis.usersByRole.reduce((sum, u) => sum + u.count, 0);
  const roleBreakdown = kpis.usersByRole
    .map((u) => `${labelFor('role', u.role)} ${u.count}`)
    .join(' · ');

  return (
    <div className="grid grid-cols-1 gap-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs sm:grid-cols-2 xl:grid-cols-4 dark:*:data-[slot=card]:bg-card">
      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Total leads</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {numberIntl.format(kpis.totalLeads)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <LuTrendingUp />
              all teams
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex items-center gap-2 font-medium">
            Cross-project pipeline <LuTrendingUp className="size-4" />
          </div>
          <div className="text-muted-foreground">Leads across every project</div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Reassignments (7d)</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {numberIntl.format(kpis.reassignments7d)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <LuTrendingUp />
              ownership changes
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex items-center gap-2 font-medium">
            Lead ownership moved <LuTrendingUp className="size-4" />
          </div>
          <div className="text-muted-foreground">Last 7 days</div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Audit events (24h)</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {numberIntl.format(kpis.auditEvents24h)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <LuActivity />
              system activity
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex items-center gap-2 font-medium">
            Actions logged <LuActivity className="size-4" />
          </div>
          <div className="text-muted-foreground">Last 24 hours</div>
        </CardFooter>
      </Card>

      <Card className="@container/card">
        <CardHeader>
          <CardDescription>Users by role</CardDescription>
          <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
            {numberIntl.format(totalUsers)}
          </CardTitle>
          <CardAction>
            <Badge variant="outline">
              <LuUsersRound />
              {kpis.usersByRole.length} roles
            </Badge>
          </CardAction>
        </CardHeader>
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          <div className="line-clamp-1 flex items-center gap-2 font-medium">
            Team composition <LuUsersRound className="size-4" />
          </div>
          <div className="text-muted-foreground line-clamp-1">
            {roleBreakdown.length > 0 ? roleBreakdown : 'No users yet'}
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
