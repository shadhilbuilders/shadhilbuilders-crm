import type { Metadata } from 'next';

import { DOCUMENT_TITLE_SUFFIX } from '@/lib/document-title';
import { getProjectBySlug } from '@/lib/server/tenant';
import { requireTenant } from '@/lib/server/tenant-guard';
import { ProjectProvider, type ProjectContextValue } from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';

/**
 * Project pages title as "Lead Inbox · Skyline | Shadhil Builders CRM".
 * A segment's title.template replaces the parent template instead of nesting
 * inside it, so the brand suffix has to be repeated here.
 *
 * Metadata never throws: on any failure it degrades to the generic name so
 * the real handling happens once, in the layout below (a throw here would
 * surface as an error page before the layout could redirect sensibly).
 */
export async function generateMetadata({
  params,
}: LayoutProps<'/[orgSlug]/projects/[projectSlug]'>): Promise<Metadata> {
  const { projectSlug } = await params;
  const result = await getProjectBySlug(projectSlug);
  const name = result.ok ? result.data.name : 'Project';

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
 *
 * FAILURE HANDLING: mirrors the org layout (2026-11-19) through the shared
 * `requireTenant` guard - an unresolved lookup is no longer an automatic 404,
 * so an expired session redirects to sign-in and an outage reaches the error
 * boundary rather than telling the user their project does not exist.
 */
export default async function ProjectLayout({
  children,
  params,
}: LayoutProps<'/[orgSlug]/projects/[projectSlug]'>) {
  const { projectSlug, orgSlug } = await params;

  const project = requireTenant(
    await getProjectBySlug(projectSlug),
    // `params` carries ancestor segments (Next docs: "from the root segment
    // down to that layout"), so orgSlug is available here.
    `/${orgSlug}/projects/${projectSlug}`,
    'this project',
  );

  const projectValue: ProjectContextValue = {
    id: project.id,
    slug: project.slug,
    name: project.name,
  };

  return <ProjectProvider project={projectValue}>{children}</ProjectProvider>;
}
