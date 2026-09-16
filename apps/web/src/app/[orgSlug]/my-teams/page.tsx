'use client';

// Work -> My Teams - T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI1).
// MANAGER-only route outside the Admin namespace. Lists every team the
// manager MANAGES and every team they're an ordinary MEMBER of (one
// manager may lead multiple teams - Decision Audit Trail #39). Backed by
// the SAME GET /api/teams endpoint Admin -> Teams uses (teams.service.ts's
// list() is now role-scoped server-side to exactly this union for MANAGER).
import { useEffect, useState } from 'react';
import { Badge, Heading, Item, ItemGroup, TypographyP } from '@paalstack/react-ui';
import { LuArrowRight } from '@paalstack/react-icons/lu';
import Link from 'next/link';

import { useTeams, type TeamListItem } from '@/hooks/queries/teams';
import { useSessionUser } from '@/lib/session';
import { orgHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';

export default function MyTeamsPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const teams = useTeams();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <Skeleton variant="users" className="py-4" />;
  }
  if (user === null || user.role !== 'MANAGER') {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only managers have a My Teams view - admins use Admin → Teams.
        </TypographyP>
      </div>
    );
  }

  const rows = teams.data ?? [];
  // "Managed" = this manager IS the team's manager. "Member" = they appear
  // on the team but don't lead it (T-TEAM-AUTHORITATIVE: a manager can be
  // an ordinary member of a DIFFERENT team they don't lead).
  const managed = rows.filter((t) => t.managerId === user.id);
  const member = rows.filter((t) => t.managerId !== user.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Teams"
        breadcrumb={[{ label: 'Work' }, { label: 'My Teams' }]}
        subtitle="Teams you manage, and teams you're a member of."
      />

      {teams.isLoading ? (
        <Skeleton variant="table" />
      ) : teams.error !== undefined && teams.error !== null ? (
        <div role="alert" className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load your teams.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {teams.error instanceof Error ? teams.error.message : 'Unexpected error.'}
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="border-border rounded-lg border p-10 text-center text-sm">
          <TypographyP className="text-xl font-medium">You don&apos;t lead or belong to a team yet.</TypographyP>
          <TypographyP className="text-muted-foreground mt-1 text-sm">
            Ask an admin to assign you as a team&apos;s manager, or add you as a member.
          </TypographyP>
        </div>
      ) : (
        <div className="space-y-6">
          <TeamSection title="You manage" teams={managed} orgSlug={orgSlug} emptyText="You don't manage any team yet." />
          <TeamSection
            title="You're a member of"
            teams={member}
            orgSlug={orgSlug}
            emptyText="You aren't an ordinary member of any other team."
          />
        </div>
      )}
    </div>
  );
}

function TeamSection({
  title,
  teams,
  orgSlug,
  emptyText,
}: {
  title: string;
  teams: TeamListItem[];
  orgSlug: string | null;
  emptyText: string;
}) {
  return (
    <div className="space-y-2">
      <TypographyP className="text-muted-foreground text-sm font-medium">{title}</TypographyP>
      {teams.length === 0 ? (
        <TypographyP className="text-muted-foreground text-sm">{emptyText}</TypographyP>
      ) : (
        <ItemGroup className="gap-2">
          {teams.map((team) => (
            <Link key={team.id} href={orgHref(orgSlug, `/my-teams/${team.id}`)} data-qa={`my-team-row-${team.id}`}>
              <Item
                variant="outline"
                size="sm"
                title={
                  <span className="flex items-center gap-2">
                    {team.name}
                    {team.managerId !== null ? <Badge variant="secondary">Manager: {team.managerName}</Badge> : null}
                  </span>
                }
                description={`${team.memberCount} member${team.memberCount === 1 ? '' : 's'}`}
                actions={<LuArrowRight className="text-muted-foreground size-4" />}
              />
            </Link>
          ))}
        </ItemGroup>
      )}
    </div>
  );
}
