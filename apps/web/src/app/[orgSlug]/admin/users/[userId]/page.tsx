'use client';

// User detail page (/admin/users/[userId]) - the specific-user page the
// Users table opens. Clicking a user's name (or anywhere on their row) in
// /admin/users lands here.
//
// The page owns the chrome (breadcrumb back to Users + a "Back to users"
// button) and the shared `UserDetailView` panel owns the body (identity,
// team, reports-to, projects, leads) together with its own loading /
// error / not-authorized branches.
//
// The title needs the user's name, so the page reads the same `useUser`
// query the panel reads - one query key, one request, two consumers.
//
// ADMIN/OWNER only (the admin layout gate plus the panel's own mirror of the
// backend guard); the backend remains the security boundary.
import { useParams } from 'next/navigation';

import { Button } from '@paalstack/react-ui';
import { LuArrowLeft } from '@paalstack/react-icons/lu';
import Link from 'next/link';

import { useUser } from '@/hooks/queries/users';
import { orgHref } from '@/lib/nav';
import { useOrgSlug } from '@/lib/tenant-context';

import { PageHeader } from '@/components/shared/PageHeader';
import { UserDetailView } from '@/components/users/UserDetailView';

export default function UserDetailPage() {
  const params = useParams<{ userId: string }>();
  const userId = typeof params?.userId === 'string' ? params.userId : null;
  const orgSlug = useOrgSlug();

  // Same query key as the panel's, so this is a cache read, not a second
  // request. `useUser` is disabled for an empty id.
  const userQuery = useUser(userId ?? undefined);
  const name = userQuery.data?.name;

  // The route always carries a `userId` segment; without one there is
  // nothing to show and no name to title the page with.
  if (userId === null) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={name ?? 'User'}
        breadcrumb={[
          { label: 'Admin' },
          { label: 'Users', href: orgHref(orgSlug, '/admin/users') },
          { label: name ?? 'User' },
        ]}
        action={
          <Button
            variant="outline"
            size="sm"
            as={Link}
            href={orgHref(orgSlug, '/admin/users')}
            data-qa="back-to-users"
            leftIcon={<LuArrowLeft className="size-4" />}
          >
            Back to users
          </Button>
        }
      />

      <UserDetailView userId={userId} />
    </div>
  );
}
