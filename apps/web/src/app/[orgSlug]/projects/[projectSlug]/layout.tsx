import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';

import { DOCUMENT_TITLE_SUFFIX } from '@/lib/document-title';
import { getProjectBySlug } from '@/lib/server/tenant';
import {
  ProjectProvider,
  type ProjectContextValue,
} from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

/**
 * Project pages title as "Lead Inbox · Skyline | Shadhil Builders CRM".
 * A segment's title.template replaces the parent template instead of nesting
 * inside it, so the brand suffix has to be repeated here.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}): Promise<Metadata> {
  const { projectSlug } = await params;
  const project = await getProjectBySlug(projectSlug);
  const name = project?.name ?? 'Project';

  return {
    title: {
      template: `%s · ${name} | ${DOCUMENT_TITLE_SUFFIX}`,
      default: name,
    },
  };
}

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
