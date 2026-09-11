// Dashboard split (2026-09-08) - pure redirect-decision helpers.
//
// The root `/` redirect and the `/overview` command-center guard both
// decide "where should this user go" from (role, projects). Extracting the
// decision into pure functions makes it unit-testable without rendering
// (useEffect doesn't fire under renderToStaticMarkup) and keeps the two
// surfaces consistent.
//
// 2026-09-11 - SLUG-BASED URL scheme: every authenticated route now lives
// under `/[orgSlug]` / `/[orgSlug]/projects/[projectSlug]`, so the redirect
// helpers build slug URLs. Callers resolve the org's SLUG (via the tenant
// context on page layouts, or useOrgSlugForId at the root) and pass it in.
import { isAdminLike } from '@/lib/session';
import { pickDefaultProject, type ProjectListItem } from '@/hooks/queries';
import { projectHref } from '@/lib/nav';
import type { Role } from '@/apis/client';

export type RedirectTarget =
  | { kind: 'login' }
  | { kind: 'command-center' }
  | { kind: 'project-dashboard'; href: string }
  | { kind: 'projects' };

/**
 * Decide the root `/` redirect target from the session + project registry.
 *   - user null (expired/errored) → /login
 *   - admin/owner                 → /{orgSlug}/overview (command center)
 *   - non-admin + default project → /{orgSlug}/projects/{slug}/dashboard
 *   - non-admin + empty registry  → /{orgSlug}/projects (no loop)
 * `orgSlug` is the resolved tenant slug (null when unavailable → safe
 * unscoped or registry fallback).
 */
export function rootRedirectTarget(
  user: { role: Role; organizationId?: string | null } | null,
  projects: ProjectListItem[],
  orgSlug: string | null = null,
): RedirectTarget {
  if (user === null) return { kind: 'login' };
  if (isAdminLike(user.role)) return { kind: 'command-center' };
  if (!orgSlug) return { kind: 'projects' };
  const project = pickDefaultProject(projects);
  if (project !== null) {
    return {
      kind: 'project-dashboard',
      href: projectHref(orgSlug, project.slug, '/dashboard'),
    };
  }
  return { kind: 'projects' };
}
/**
 * Decide the `/overview` command-center guard target.
 *   - admin/owner                 → null (render the command center)
 *   - non-admin + default project → /{orgSlug}/projects/{slug}/dashboard
 *   - non-admin + empty registry  → /{orgSlug}/projects (no loop)
 */
export function commandCenterRedirectTarget(
  role: Role | undefined,
  projects: ProjectListItem[],
  orgSlug: string | null = null,
): string | null {
  if (isAdminLike(role)) return null;
  // No org → go to the registry (the app can't resolve a work URL without
  // the org segment; /projects is the safe landing).
  if (!orgSlug) return '/projects';
  const project = pickDefaultProject(projects);
  if (project !== null) {
    return projectHref(orgSlug, project.slug, '/dashboard');
  }
  return `/${orgSlug}/projects`;
}
