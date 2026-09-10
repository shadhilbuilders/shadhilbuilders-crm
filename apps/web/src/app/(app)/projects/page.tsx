'use client';

// Project registry management - T-ProjectSwitch (2026-09-05), rebuilt on the
// @paalstack/react-ui DataTable (2026-09-10) to mirror the Users page.
//
// ADMIN/OWNER surface (mirrors users/page.tsx guard shape):
//   - Create project      → POST /api/projects        (ADMIN/OWNER)
//   - Edit / rename       → PATCH /api/projects/:id   (ADMIN/OWNER)
//   - Manage staff        → ProjectMembersBody        (MANAGER/ADMIN/OWNER)
//   - Delete              → DELETE /api/projects/:id  (ADMIN/OWNER, soft)
//
// Server-driven (T-PROJ-SRVPG): the list is SORTED + SEARCHED + PAGINATED on
// the server (?search=&limit=&offset=, mirroring useUsers). The DataTable's
// client-side global filter is a no-op - the backend already returns the
// filtered page.
//
// The server is the authoritative wall (403 semantics live in
// ProjectsService); the UI mirrors them for fast feedback and shows real API
// errors verbatim (409 = "project still has bookings").
//
// Rule 7c (dialog testability): the create/edit form bodies are
// separately-exported components; slug derivation is a pure helper tested in
// the service suite.

import {
  Badge,
  Button,
  DataTable,
  Dialog,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  Heading,
  Loading,
  Tooltip,
  TypographyP,
} from '@paalstack/react-ui';
import type { DataTableColumnDef } from '@paalstack/react-ui';
import { useDebouncedValue } from '@paalstack/react-hooks';
import {
  LuEllipsis,
  LuPencil,
  LuPlus,
  LuTrash2,
  LuUsersRound,
} from '@paalstack/react-icons/lu';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import {
  useProjectsTable,
  type ProjectListItem,
  type ProjectsFilter,
} from '@/hooks/queries';
import { projectHref } from '@/lib/nav';
import {
  canManageProjectMembers,
  canManageUsers,
  isAdminLike,
  useSessionUser,
} from '@/lib/session';

import { Skeleton } from '@/components/shared/Skeleton';
import {
  ProjectDeleteBody,
  ProjectFormBody,
  ProjectMembersBody,
} from '@/components/projects/project-form-bodies';
import { PageHeader } from '@/components/shared/PageHeader';
import Link from 'next/link';

export default function ProjectsPage() {
  const { user, isPending: sessionPending } = useSessionUser();

  // Server-side search (mirrors users): debounced 300ms, fires at ≥2 chars.
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);
  const serverSearch =
    debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined;

  // Server-side pagination (1-indexed DataTable page → offset).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const projectsQuery = useProjectsTable({
    search: serverSearch,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectListItem | null>(null);
  const [membersTarget, setMembersTarget] = useState<ProjectListItem | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(
    null,
  );
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // page → "Hydration failed because the server rendered HTML didn't match
  // the client." Render the skeleton for the first client paint too, then
  // swap after mount (same pattern as users/page.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <Skeleton variant="users" className="py-4" />;
  }
  if (user === null || !canManageUsers(user.role)) {
    return (
      <div className="py-24 text-center text-sm">
        <Heading className="mb-2">Not authorized</Heading>
        <TypographyP className="text-muted-foreground">
          Only admins can manage projects.
        </TypographyP>
      </div>
    );
  }

  // Soft-delete projects + member management (autoplan 2026-09-09 / -10).
  const canDelete = isAdminLike(user.role);
  const canManageMembers = canManageProjectMembers(user.role);

  const projects = Array.isArray(projectsQuery.data?.projects)
    ? projectsQuery.data.projects
    : [];
  const total = projectsQuery.data?.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        breadcrumb={[{ label: 'Admin' }, { label: 'Projects' }]}
        subtitle={
          canDelete
            ? 'Create, rename, and delete the project registry. Deleting a project with bookings is blocked.'
            : 'Create and rename projects. Deleting requires ADMIN or the account owner.'
        }
      />

      {projectsQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : projectsQuery.error !== null && projectsQuery.error !== undefined ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 rounded-lg border p-6 text-center"
        >
          <p className="text-sm font-medium">Couldn&apos;t load projects.</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {projectsQuery.error instanceof Error
              ? projectsQuery.error.message
              : 'Unexpected error.'}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void projectsQuery.refetch()}
            data-qa="projects-retry-button"
          >
            Try again
          </Button>
        </div>
      ) : (
        <ProjectTable
          projects={projects}
          total={total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          canDelete={canDelete}
          canManageMembers={canManageMembers}
          isFetching={projectsQuery.isFetching}
          search={search}
          onSearchChange={(next) => {
            setSearch(next);
            setPage(1);
          }}
          onEdit={setEditTarget}
          onMembers={setMembersTarget}
          onDelete={setDeleteTarget}
          createTrigger={
            <Dialog
              trigger={
                <Button leftIcon={<LuPlus className="h-4 w-4" />}>
                  New project
                </Button>
              }
              header={{ title: 'Create a project' }}
              open={createOpen}
              onOpenChange={setCreateOpen}
            >
              <ProjectFormBody
                mode="create"
                onDone={() => setCreateOpen(false)}
              />
            </Dialog>
          }
        />
      )}

      <EditProjectDialog
        target={editTarget}
        onClose={() => setEditTarget(null)}
      />

      <DeleteProjectDialog
        target={deleteTarget}
        onClose={() => setDeleteTarget(null)}
      />

      <Dialog
        trigger={<button hidden />}
        header={{ title: 'Manage staff' }}
        open={membersTarget !== null}
        onOpenChange={(open) => {
          if (!open) setMembersTarget(null);
        }}
        contentClassName="max-h-[calc(100dvh-4rem)] overflow-hidden sm:max-w-lg"
      >
        {membersTarget !== null ? (
          <ProjectMembersBody
            project={membersTarget}
            canManage={canManageMembers}
            onDone={() => setMembersTarget(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table + row actions (DataTable, mirrors users/page.tsx)
// ---------------------------------------------------------------------------

/**
 * In-app row-actions menu for a project row (Edit / Manage staff / Delete),
 * gated by the actor's role. Edit is ADMIN/OWNER, Manage staff is
 * MANAGER/ADMIN/OWNER, Delete is ADMIN/OWNER (soft). Uses the published
 * DropdownMenu primitives + Tooltip (the shipped DataTableActionItem has no
 * disabled/disabledReason field) - same approach as users/UserRowActions.
 */
function ProjectRowActions({
  target,
  canDelete,
  canManageMembers,
  onEdit,
  onMembers,
  onDelete,
}: {
  target: ProjectListItem;
  canDelete: boolean;
  canManageMembers: boolean;
  onEdit: (project: ProjectListItem) => void;
  onMembers: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  const isDefault = target.slug === 'shadhil-metro-heights';

  type ActionItem = {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    disabledReason?: string;
    onClick: () => void;
  };

  const items: ActionItem[] = [
    {
      label: 'Edit',
      icon: LuPencil,
      disabledReason: !canDelete
        ? 'Only ADMIN or OWNER can edit projects'
        : undefined,
      onClick: () => onEdit(target),
    },
    {
      label: canManageMembers ? 'Manage staff' : 'View staff',
      icon: LuUsersRound,
      onClick: () => onMembers(target),
    },
    {
      label: 'Delete',
      icon: LuTrash2,
      disabledReason: !canDelete
        ? 'Only ADMIN or OWNER can delete projects'
        : isDefault
          ? "The default project can't be deleted"
          : undefined,
      onClick: () => onDelete(target),
    },
  ];

  return (
    <div className="text-right" data-qa="project-row-actions">
      <DropdownMenuRoot>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="flex size-8 p-0"
              aria-label={`Actions for ${target.name}`}
              data-qa="data-table-row-actions-button"
            >
              <LuEllipsis className="size-4" data-qa="data-table-row-actions-icon" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          {items.map((item) => {
            if (item.disabledReason) {
              return (
                <Tooltip
                  key={item.label}
                  content={item.disabledReason}
                  side="right"
                  trigger={
                    <DropdownMenuItem
                      className="pointer-events-auto cursor-not-allowed! opacity-50"
                      data-qa="data-table-row-action-item"
                    >
                      <item.icon
                        className="mr-2 size-4 text-muted-foreground"
                        data-qa="data-table-row-action-item-icon"
                      />
                      {item.label}
                    </DropdownMenuItem>
                  }
                />
              );
            }
            return (
              <DropdownMenuItem
                key={item.label}
                onClick={item.onClick}
                data-qa="data-table-row-action-item"
              >
                <item.icon
                  className="mr-2 size-4 text-muted-foreground"
                  data-qa="data-table-row-action-item-icon"
                />
                {item.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </div>
  );
}

function ProjectTable({
  projects,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  canDelete,
  canManageMembers,
  isFetching,
  search,
  onSearchChange,
  onEdit,
  onMembers,
  onDelete,
  createTrigger,
}: {
  projects: ProjectListItem[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  canDelete: boolean;
  canManageMembers: boolean;
  isFetching: boolean;
  search: string;
  onSearchChange: (next: string) => void;
  onEdit: (project: ProjectListItem) => void;
  onMembers: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
  createTrigger: React.ReactNode;
}) {
  const router = useRouter();

  const columns = useMemo<DataTableColumnDef<ProjectListItem>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-45">
            <Link
              href={projectHref(row.original.id, '/dashboard')}
              className="text-link text-sm font-medium hover:underline hover:underline-offset-2"
              data-qa={`project-row-link-${row.original.slug}`}
            >
              {row.original.name}
            </Link>
            {row.original.slug === 'shadhil-metro-heights' ? (
              <Badge className="ml-2 text-xs" variant="muted">Default</Badge>
            ) : null}
          </div>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'slug',
        header: 'Slug',
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">{row.original.slug}</span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: 'reraNumber',
        header: 'RERA',
        cell: ({ row }) => (
          <span className="text-muted-foreground hidden text-sm md:table-cell">
            {row.original.reraNumber ?? '-'}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'cmdaNumber',
        header: 'CMDA',
        cell: ({ row }) => (
          <span className="text-muted-foreground hidden text-sm md:table-cell">
            {row.original.cmdaNumber ?? '-'}
          </span>
        ),
        enableSorting: false,
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-muted-foreground hidden text-sm lg:table-cell">
            {new Date(row.original.createdAt).toLocaleDateString()}
          </span>
        ),
        enableSorting: false,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <ProjectRowActions
            target={row.original}
            canDelete={canDelete}
            canManageMembers={canManageMembers}
            onEdit={onEdit}
            onMembers={onMembers}
            onDelete={onDelete}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [canDelete, canManageMembers, onEdit, onMembers, onDelete, router],
  );

  const isSearchActive = search.trim().length > 0;

  return (
    <div className="space-y-2">
      <DataTable
        columns={columns}
        rows={projects}
        // Search is server-side (onSearchValueChange → API). The DataTable's
        // built-in client-side global filter is redundant here AND would hide
        // rows over the already-filtered page - make it a no-op.
        globalFilterFn={() => true}
        search={{
          accessorKey: ['name', 'slug'],
          placeholder: 'Search by name or slug...',
          searchValue: search,
          onSearchValueChange: onSearchChange,
        }}
        showPagination
        paginationProps={{
          total,
          currentPage: page,
          onPageChange,
          pageSize,
          onPageSizeChange,
          pageSizeOptions: [10, 25, 50],
          showTotalResults: true,
          showOnlyIfTotalGreaterThanPageSize: true,
        }}
        isLoading={isFetching}
        loadingContent={<Loading content="Loading projects..." />}
        toolbarRightSideContent={createTrigger}
        emptyContent={
          isSearchActive ? (
            <div className="rounded-lg p-10 text-center space-y-1">
              <TypographyP className="text-xl font-medium">
                No projects match your search.
              </TypographyP>
              <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                Check the spelling or try a different name or slug.
              </TypographyP>
            </div>
          ) : (
            <div className="rounded-lg p-10 text-center space-y-1">
              <TypographyP className="text-xl font-medium">
                No projects yet.
              </TypographyP>
              <TypographyP className="text-muted-foreground text-sm not-first:mt-0">
                Create the first project to get started.
              </TypographyP>
              <div className="flex justify-center pt-2">{createTrigger}</div>
            </div>
          )
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog (reuses ProjectFormBody - separately exported, rule 7c)
// ---------------------------------------------------------------------------

function EditProjectDialog({
  target,
  onClose,
}: {
  target: ProjectListItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      trigger={<button hidden />}
      header={{ title: 'Edit project' }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target !== null ? (
        <ProjectFormBody mode="edit" project={target} onDone={onClose} />
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm dialog (reuses ProjectDeleteBody - soft delete)
// ---------------------------------------------------------------------------

function DeleteProjectDialog({
  target,
  onClose,
}: {
  target: ProjectListItem | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      trigger={<button hidden />}
      header={{ title: 'Delete project' }}
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target !== null ? (
        <ProjectDeleteBody project={target} onDone={onClose} />
      ) : null}
    </Dialog>
  );
}

// Keep the type used by the members/dialogs + pickDefaultProject import stable.
export type { ProjectsFilter };
