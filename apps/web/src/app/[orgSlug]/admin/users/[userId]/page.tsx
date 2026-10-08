// /admin/users/[userId] was folded into /admin/staff-permission, which renders
// the same user detail view under a searchable user picker. Keep the old URL
// working for bookmarks and deep links.
import { redirect } from 'next/navigation';

export default async function UserDetailRedirectPage({
  params,
}: {
  params: Promise<{ orgSlug: string; userId: string }>;
}) {
  const { orgSlug, userId } = await params;
  redirect(
    `/${orgSlug}/admin/staff-permission?userId=${encodeURIComponent(userId)}`,
  );
}
