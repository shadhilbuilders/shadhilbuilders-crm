'use client';

// Work -> Projects -> [projectSlug] -> My Team -> [teamId] roster - T-TEAM-AUTHORITATIVE (2026-09-13, design doc UI1).
// MANAGER-only. Read-only member list; "Remove from this team" is offered ONLY when the viewer manages THIS specific team.
import { useEffect, useState } from 'react';
import { Button, Heading, Loading, TypographyP } from '@paalstack/react-ui';
import { LuArrowLeft } from '@paalstack/react-icons/lu';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { useTeam } from '@/hooks/queries/teams';
import { TeamRosterMemberRow } from '@/components/teams/team-roster';
import { isAdminLike, useSessionUser } from '@/lib/session';
import { projectHref } from '@/lib/nav';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';

import { Skeleton } from '@/components/shared/Skeleton';
import { PageHeader } from '@/components/shared/PageHeader';

export default function TeamRosterPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const params = useParams<{ teamId: string }>();
  const teamId = typeof params?.teamId === 'string' ? params.teamId : null;
  const teamQuery = useTeam(teamId ?? undefined);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending || teamId === null) {
    return <Skeleton variant="users" className="py-4" />;
  }
  // Admin/Owner get redirected in spirit to Admin -> Teams (they can still
  // reach this URL, but the canonical surface for them is the admin
  // roster - this page's value-add, the Remove-from-team gate, is
  // MANAGER-specific). Keep it simple: only MANAGER uses this route.
  if (user === null || (user.role !== 'MANAGER' && !isAdminLike(user.role))) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only managers have a My Team view.
        </TypographyP>
      </div>
    );
  }

  const team = teamQuery.data;
  const isManagerOfThisTeam = team?.manager?.id === user.id;

  const baseHref = orgSlug && projectSlug ? `/${orgSlug}/projects/${projectSlug}` : '/';

  return (
    <div className="space-y-6">
      <PageHeader
        title={team?.name ?? 'Team'}
        breadcrumb={[
          { label: 'Work', href: orgSlug && projectSlug ? projectHref(orgSlug, projectSlug, '/dashboard') : '/work' },
          { label: 'My Team', href: `${baseHref}/my-team` },
          { label: team?.name ?? 'Team' },
        ]}
        subtitle={
          team?.manager
            ? isManagerOfThisTeam
              ? 'You manage this team.'
              : `Managed by ${team.manager.name}.`
            : 'No manager assigned.'
        }
      />

      {teamQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : teamQuery.error !== null && teamQuery.error !== undefined ? (
        <div role="alert" className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center">
          <p className="text-sm font-medium">Couldn&apos;t load this team.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {teamQuery.error instanceof Error ? teamQuery.error.message : 'Unexpected error.'}
          </p>
          <Button variant="outline" className="mt-3" onClick={() => void teamQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : team === undefined ? (
        <Loading content="Loading team..." />
      ) : team.members.length === 0 ? (
        <div className="border-border rounded-lg border p-10 text-center text-sm">
          <TypographyP className="text-xl font-medium">No members in this team.</TypographyP>
        </div>
      ) : (
        <div className="space-y-2">
          {team.members.map((member) => (
            <TeamRosterMemberRow
              key={member.userId}
              teamId={team.id}
              teamName={team.name}
              member={member}
              managerId={team.manager?.id ?? null}
              managerName={team.manager?.name ?? null}
              ownerName={team.owner?.name ?? null}
              canRemove={isManagerOfThisTeam}
              dataQaPrefix="my-team-member"
            />
          ))}
        </div>
      )}

      <div className="flex justify-end pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          as={Link}
          href={`${baseHref}/my-team`}
          leftIcon={<LuArrowLeft className="size-4" />}
        >
          Back to My Team
        </Button>
      </div>
    </div>
  );
}