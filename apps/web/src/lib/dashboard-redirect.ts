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

/**
 * The project work surface a role lands on when it enters Work.
 *
 * ENGINEER lands on `/site`, the capture home that replaced Inventory for them
 * (2026-11-08): the inventory grid is a sales surface full of rupees, and their
 * real question is "which villa have I not photographed yet".
 *
 * TELECALLER deliberately does NOT: DESIGN.md §1 makes them the first-touch lead
 * owner from NEW through VISIT_SCHEDULED, so `/dashboard` (their queue) is where
 * their work starts. They gain the Site updates nav item; they do not lose the
 * Lead Inbox.
 */
export function workSurfaceForRole(role: Role | undefined): string {
  return role === 'ENGINEER' ? '/site' : '/dashboard';
}

/** The role's project work surface, or `/{orgSlug}/work` when the registry
 *  is empty. */
export function workLandingHref(
  orgSlug: string | null,
  projects: ProjectListItem[],
  role: Role | undefined = undefined,
): string {
  if (!orgSlug) return '/work';
  const project = pickDefaultProject(projects);
  if (project !== null) {
    return projectHref(orgSlug, project.slug, workSurfaceForRole(role));
  }
  return `/${orgSlug}/work`;
}

export type RedirectTarget =
  | { kind: 'login' }
  | { kind: 'command-center' }
  | { kind: 'project-work'; href: string }
  | { kind: 'work'; href: string };

/**
 * Decide the root `/` redirect target from the session + project registry.
 *   - user null (expired/errored) → /login
 *   - admin/owner                 → /{orgSlug}/admin (command center)
 *   - engineer + default project → /{orgSlug}/projects/{slug}/site
 *   - non-admin + default project → /{orgSlug}/projects/{slug}/dashboard
 *   - non-admin + empty registry  → /{orgSlug}/work (not the admin registry)
 */
export function rootRedirectTarget(
  user: { role: Role; organizationId?: string | null } | null,
  projects: ProjectListItem[],
  orgSlug: string | null = null,
): RedirectTarget {
  if (user === null) return { kind: 'login' };
  if (isAdminLike(user.role)) return { kind: 'command-center' };
  const href = workLandingHref(orgSlug, projects, user.role);
  const project = pickDefaultProject(projects);
  if (orgSlug && project !== null) {
    return { kind: 'project-work', href };
  }
  return { kind: 'work', href };
}
/**
 * Decide the `/admin/overview` command-center guard target.
 *   - admin/owner                 → null (render the command center)
 *   - engineer + default project → /{orgSlug}/projects/{slug}/site
 *   - non-admin + default project → /{orgSlug}/projects/{slug}/dashboard
 *   - non-admin + empty registry  → /{orgSlug}/work (no loop into admin)
 */
export function commandCenterRedirectTarget(
  role: Role | undefined,
  projects: ProjectListItem[],
  orgSlug: string | null = null,
): string | null {
  if (isAdminLike(role)) return null;
  return workLandingHref(orgSlug, projects, role);
}
