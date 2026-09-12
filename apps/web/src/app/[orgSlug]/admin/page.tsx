import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/** Admin launcher: /{orgSlug}/admin → /{orgSlug}/admin/overview */
export default async function AdminIndexPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(`/${orgSlug}/admin/overview`);
}
