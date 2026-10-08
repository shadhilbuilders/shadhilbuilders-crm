'use client';

// Staff Permission (/admin/staff-permission). ADMIN/OWNER pick any user from a
// server-searched Combobox and see that user's full detail panel below
// (identity, team, reports-to, projects, leads) - the same view that used to
// live at /admin/users/[userId], which now redirects here.
//
// The selected user lives in the URL (?userId=) so a selection is shareable
// and survives a refresh.
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Box, Heading, TypographyP } from '@paalstack/react-ui';
import { LuKeyRound } from '@paalstack/react-icons/lu';

import { isAdminLike, useSessionUser } from '@/lib/session';
import { orgHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';
import { UserDetailView } from '@/components/users/UserDetailView';
import { UserPicker } from '@/components/users/UserPicker';

const PAGE_PATH = '/admin/staff-permission';

export default function StaffPermissionPage() {
  // useSearchParams() needs a Suspense boundary (App Router requirement).
  return (
    <Suspense fallback={<Skeleton variant="users" className="py-4" />}>
      <StaffPermissionPageInner />
    </Suspense>
  );
}

function StaffPermissionPageInner() {
  const { user, isPending: sessionPending } = useSessionUser();
  const orgSlug = useOrgSlug();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedUserId = searchParams.get('userId') ?? '';

  // Hydration guard (same pattern as /admin/users).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <Skeleton variant="users" className="py-4" />;
  }
  if (user === null || !isAdminLike(user.role)) {
    return (
      <Box className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only owners and admins can view staff permissions.
        </TypographyP>
      </Box>
    );
  }

  function handleSelect(userId: string) {
    const base = orgHref(orgSlug, PAGE_PATH);
    router.replace(
      userId === '' ? base : `${base}?userId=${encodeURIComponent(userId)}`,
    );
  }

  return (
    <Box className="space-y-6">
      <PageHeader
        title="Staff Permission"
        breadcrumb={[{ label: 'Admin' }, { label: 'Staff Permission' }]}
        subtitle="Search for a staff member to see their full details."
      />

      <UserPicker value={selectedUserId} onValueChange={handleSelect} />

      {selectedUserId === '' ? (
        <Box
          className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center"
          role="status"
          data-qa="staff-permission-empty"
        >
          <LuKeyRound className="size-6" />
          <TypographyP className="text-sm not-first:mt-0">
            Select a staff member to view their details
          </TypographyP>
        </Box>
      ) : (
        <UserDetailView key={selectedUserId} userId={selectedUserId} />
      )}
    </Box>
  );
}
