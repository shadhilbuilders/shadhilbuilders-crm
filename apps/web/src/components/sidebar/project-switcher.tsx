'use client';

// ProjectSwitcher - sidebar-07 pattern, adapted for shadhil-crm.
//
// T-ProjectSwitch (2026-09-05): REAL project switching. The dropdown rows
// are Project-table rows (GET /api/projects); clicking one navigates to the
// SAME work surface under the new project's SLUG:
//   /[orgSlug]/projects/[projectSlug]/<surface>
// Work surfaces (dashboard, leads, visits, inventory, bookings,
// notifications) live under that segment and every list query filters by
// the resolved project id (context). Selection is URL-owned: no
// localStorage, no context - the URL is the source of truth (shareable,
// back/forward safe).
//
// Default project (when the URL carries none): the product-locked
// primary project (slug 'shadhil-metro-heights'), falling back to the
// first registry row - see pickDefaultProject() in hooks/queries/projects.
//
// Manage projects (create / rename / edit): admin-class surface inside
// the dropdown footer. Delete is owner-only and guarded server-side
// (409 when bookings exist). The manage entry lands on
// `/[orgSlug]/admin/projects` (the registry) and is OWNER/ADMIN only.
//
// Honest state contract: the dropdown is always openable, even when
// the projects list is empty (the BE module might not be wired, the
// user's session might not be authenticated, etc). An empty list
// shows a "No projects" item rather than a fake spinner.
//
// Positioning: Base UI Menu (via @paalstack/react-ui's DropdownMenu*)
// uses the render-prop composition pattern (the same one the topbar's
// UserMenu popover uses with PopoverTrigger render={<Button/>}). The
// trigger renders the SidebarMenuButton; the content positions right
// on desktop, bottom on mobile (useSidebar().isMobile).

import { useRouter, usePathname } from 'next/navigation';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@paalstack/react-ui';
import { LuBuilding2, LuChevronsUpDown, LuPlus } from '@paalstack/react-icons/lu';

import { projectHref } from '@/lib/nav';

export type ProjectListItem = {
  id: string;
  slug: string;
  name: string;
  address: string;
  reraNumber: string | null;
  cmdaNumber: string | null;
  createdAt: string;
};

export function ProjectSwitcher({
  projects,
  activeProjectSlug,
  activeOrgSlug,
  canManageProjects,
}: {
  projects: ProjectListItem[];
  /** The active project slug from the URL's /projects/<slug> segment. */
  activeProjectSlug: string | null;
  /** The active org slug from the URL's first segment. */
  activeOrgSlug: string | null;
  /** ADMIN/OWNER only - shows the manage-projects dialog entry. */
  canManageProjects: boolean;
}) {
  const { isMobile } = useSidebar();
  const router = useRouter();
  const pathname = usePathname();

  const active =
    projects.find((p) => p.slug === activeProjectSlug) ?? projects[0] ?? null;

  // Determine the current work surface from the pathname.
  // Slug scheme: /[orgSlug]/projects/[projectSlug]/<surface>. The work
  // surface is segment 3 (/.../leads/abc -> /leads). Fall back to /dashboard.
  const currentWorkSurface = (() => {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return '/dashboard';
    // A project work surface: segments = [orgSlug, 'projects', projectSlug, surface, ...]
    if (segments.length >= 3 && segments[1] === 'projects') {
      return `/${segments[3] ?? 'dashboard'}`;
    }
    // On an org-level page without a project, stay on dashboard.
    return '/dashboard';
  })();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenuRoot>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="cursor-pointer data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                data-qa="project-switcher-trigger"
                aria-label="Switch project"
              >
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <LuBuilding2 className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {active?.name ?? 'No project'}
                  </span>
                  <span className="truncate text-xs">
                    {active !== null ? active.slug : 'Select a project'}
                  </span>
                </div>
                <LuChevronsUpDown className="ml-auto" />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? 'bottom' : 'right'}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Projects
            </DropdownMenuLabel>
            {projects.length === 0 ? (
              <div
                className="text-muted-foreground px-2 py-3 text-center text-xs"
                data-qa="project-switcher-empty"
              >
                No projects available
              </div>
            ) : (
              projects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  data-qa="project-switcher-item"
                  data-active={project.id === active?.id}
                  className="data-[active=true]:bg-accent data-[active=true]:text-accent-foreground cursor-pointer gap-2 p-2"
                  onClick={() => {
                    // Switch: navigate to the SAME work surface under the
                    // new project's slug, within the active org's slug.
                    const targetHref = projectHref(
                      activeOrgSlug,
                      project.slug,
                      currentWorkSurface,
                    );
                    router.push(targetHref);
                  }}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border">
                    <LuBuilding2 className="size-3.5 shrink-0" />
                  </div>
                  {project.name}
                  {project.id === active?.id ? (
                    <span
                      aria-hidden
                      className="text-muted-foreground ml-auto text-xs"
                    >
                      Active
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
            {canManageProjects ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-qa="project-switcher-manage"
                  className="cursor-pointer gap-2 p-2"
                  onClick={() => {
                    router.push(
                      activeOrgSlug
                        ? `/${activeOrgSlug}/admin/projects`
                        : '/admin/projects',
                    );
                  }}
                >
                  <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                    <LuPlus className="size-4" />
                  </div>
                  <div className="font-medium">Manage projects</div>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
