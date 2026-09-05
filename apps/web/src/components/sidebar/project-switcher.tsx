'use client';

// ProjectSwitcher - sidebar-07 pattern, adapted for shadhil-crm.
//
// In shadhil-crm the rows in this dropdown represent PROJECTS (not
// abstract "teams"). Today the schema has one project at a time
// (Shadhil Metro Heights is the live one; future ones are planned:
// Skyline Towers, Lakeview Residences). The dropdown surfaces the
// full list so the user can see what's coming.
//
// This is a DISPLAY-ONLY switcher for now (T-Sidebar07, 2026-09-05).
// Clicking a project does NOT yet change which leads/visits/etc the
// user sees - that requires a schema change (Lead.projectId column)
// and is tracked as a follow-up. Until that lands, the active project
// remains User.teamId (the user's home project from the seed).
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

export type ProjectListItem = {
  id: string;
  name: string;
  defaultAssigneeId: string | null;
  memberCount: number;
};

export function ProjectSwitcher({
  projects,
  activeProjectId,
}: {
  projects: ProjectListItem[];
  /** The user's current project (User.teamId). Used to mark the active row. */
  activeProjectId: string | null;
}) {
  const { isMobile } = useSidebar();
  const active = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;

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
                    {active !== null
                      ? `${active.memberCount} member${active.memberCount === 1 ? '' : 's'}`
                      : 'Select a project'}
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
                  data-active={project.id === activeProjectId}
                  className="data-[active=true]:bg-accent data-[active=true]:text-accent-foreground cursor-pointer gap-2 p-2"
                >
                  <div className="flex size-6 items-center justify-center rounded-md border">
                    <LuBuilding2 className="size-3.5 shrink-0" />
                  </div>
                  {project.name}
                  {project.id === activeProjectId ? (
                    <span
                      aria-hidden
                      className="text-muted-foreground ml-auto text-xs"
                    >
                      active
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled
              data-qa="project-switcher-add"
              className="text-muted-foreground gap-2 p-2"
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <LuPlus className="size-4" />
              </div>
              <div className="font-medium">Add project</div>
              <span
                aria-hidden
                className="text-muted-foreground ml-auto text-[10px] uppercase tracking-wide"
              >
                Soon
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenuRoot>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}