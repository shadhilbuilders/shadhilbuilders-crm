import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import {
  ProjectProvider,
  type ProjectContextValue,
} from '@/lib/tenant-context';
import { getProjectBySlug } from '@/lib/server/tenant';

export const dynamic = 'force-dynamic';

/**
 * Server project layout - resolves the `[projectSlug]` URL segment to the
 * real project (org-scoped via the session JWT, so RLS gates it) and hands
 * it down via ProjectProvider. Pages consume `useProjectId()` (id for API
 * hooks) / `useProjectSlug()` (slug for hrefs); internals stay id-keyed.
 *
 * The org is already resolved by the enclosing [orgSlug] OrganizationLayout;
 * this layout only needs to resolve the project within it.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;

  const project = await getProjectBySlug(projectSlug);
  if (project === null) notFound();

  const projectValue: ProjectContextValue = {
    id: project.id,
    slug: project.slug,
    name: project.name,
  };

  return <ProjectProvider project={projectValue}>{children}</ProjectProvider>;
}
