// Dashboard split (2026-09-08) - pure redirect-decision helpers.
//
// The root `/` redirect and the `/overview` command-center guard both
// decide "where should this user go" from (role, projects). Extracting the
// decision into pure functions makes it unit-testable without rendering
// (useEffect doesn't fire under renderToStaticMarkup) and keeps the two
// surfaces consistent.

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
 *   - admin/owner                 → /overview (command center)
 *   - non-admin + default project → /{projectId}/dashboard
 *   - non-admin + empty registry  → /projects (no loop)
 */
export function rootRedirectTarget(
  user: { role: Role } | null,
  projects: ProjectListItem[],
): RedirectTarget {
  if (user === null) return { kind: 'login' };
  if (isAdminLike(user.role)) return { kind: 'command-center' };
  const project = pickDefaultProject(projects);
  if (project !== null) {
    return { kind: 'project-dashboard', href: projectHref(project.id, '/dashboard') };
  }
  return { kind: 'projects' };
}

/**
 * Decide the `/overview` command-center guard target.
 *   - admin/owner                 → null (render the command center)
 *   - non-admin + default project → /{projectId}/dashboard
 *   - non-admin + empty registry  → /projects (no loop)
 */
export function commandCenterRedirectTarget(
  role: Role | undefined,
  projects: ProjectListItem[],
): string | null {
  if (isAdminLike(role)) return null;
  const project = pickDefaultProject(projects);
  if (project !== null) {
    return projectHref(project.id, '/dashboard');
  }
  return '/projects';
}
