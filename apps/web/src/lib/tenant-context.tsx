'use client';

// Client contexts that carry the RESOLVED tenant identity down to pages.
//
// The URL is slug-based (`/[orgSlug]` / `/[orgSlug]/projects/[projectSlug]`),
// but pages and API hooks are id-keyed. The async server layouts resolve the
// slug → row (getOrganizationBySlug / getProjectBySlug) and render these
// providers with the resolved ids. Client components then read the id for
// API calls and the slug for building hrefs — so page internals stay
// id-based and only the URL surface / nav change (confirmed decision 2026-09-11).
import { createContext, useContext } from 'react';

export type OrgContextValue = {
  /** Resolved org id (tenant key for id-keyed APIs/hooks). */
  id: string;
  /** Resolved org slug (public URL identity). */
  slug: string;
  /** Display name. */
  name: string;
} | null;

const OrgContext = createContext<OrgContextValue>(null);

export function OrganizationProvider({
  organization,
  children,
}: {
  organization: OrgContextValue;
  children: React.ReactNode;
}) {
  return <OrgContext.Provider value={organization}>{children}</OrgContext.Provider>;
}

/** The resolved organization (null when not under an org layout). */
export function useOrg(): OrgContextValue {
  return useContext(OrgContext);
}

export type ProjectContextValue = {
  /** Resolved project id (id-keyed APIs/hooks). */
  id: string;
  /** Resolved project slug (public URL identity). */
  slug: string;
  /** Display name. */
  name: string;
} | null;

const ProjectContext = createContext<ProjectContextValue>(null);

export function ProjectProvider({
  project,
  children,
}: {
  project: ProjectContextValue;
  children: React.ReactNode;
}) {
  return <ProjectContext.Provider value={project}>{children}</ProjectContext.Provider>;
}

/** The resolved project (null when not under a project layout). */
export function useProject(): ProjectContextValue {
  return useContext(ProjectContext);
}

/** The active project id (for id-keyed API hooks), or null. */
export function useProjectId(): string | null {
  return useProject()?.id ?? null;
}

/** The active org id (for id-keyed API hooks), or null. */
export function useOrgId(): string | null {
  return useOrg()?.id ?? null;
}

/** The active org slug (for href building), or null. */
export function useOrgSlug(): string | null {
  return useOrg()?.slug ?? null;
}

/** The active project slug (for href building), or null. */
export function useProjectSlug(): string | null {
  return useProject()?.slug ?? null;
}
