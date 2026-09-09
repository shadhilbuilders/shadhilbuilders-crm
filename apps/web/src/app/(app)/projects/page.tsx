'use client';

// Project registry management - T-ProjectSwitch (2026-09-05).
//
// ADMIN/OWNER surface (mirrors users/page.tsx guard shape):
//   - Create project      → POST /api/projects   (ADMIN/OWNER)
//   - Rename / edit       → PATCH /api/projects/:id (ADMIN/OWNER)
//   - Delete              → DELETE /api/projects/:id (OWNER only)
//
// The server is the authoritative wall (403 semantics live in
// ProjectsService); the UI mirrors them for fast feedback and shows real
// API errors verbatim (409 = "project still has bookings").
//
// Rule 7c (dialog testability): the create/edit form bodies are
// separately-exported components; slug derivation is a pure helper
// tested in the service suite (slugifyProjectName lives backend-side -
// the client just displays the derived slug).

import {
  Button,
  Dialog,
  Heading,
  TypographyP,
} from '@paalstack/react-ui';
import { LuPencil, LuPlus, LuTrash2 } from '@paalstack/react-icons/lu';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  useProjects,
  type ProjectListItem,
} from '@/hooks/queries';
import { projectHref } from '@/lib/nav';
import {
  canManageUsers,
  useSessionUser,
} from '@/lib/session';

import { Skeleton } from '@/components/shared/Skeleton';
import {
  ProjectDeleteBody,
  ProjectFormBody,
} from '@/components/projects/project-form-bodies';
import { PageHeader } from '@/components/shared/PageHeader';

export default function ProjectsPage() {
  const { user, isPending: sessionPending } = useSessionUser();
  const projectsQuery = useProjects();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ProjectListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(
    null,
  );
  const [mounted, setMounted] = useState(false);

  // Better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending=true during SSR. Without this gate the
  // server HTML shows the skeleton while hydration swaps it for the real
  // page → "Hydration failed because the server rendered HTML didn't match
  // the client." Render the skeleton for the first client paint too, then
  // swap after mount (same pattern as app-header.tsx).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return <Skeleton variant="user" className="py-24" />;
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

  const isOwner = user.role === 'OWNER';
  const projects = projectsQuery.data ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        breadcrumb={[{ label: 'Admin' }, { label: 'Projects' }]}
        subtitle={
          isOwner
            ? 'Create, rename, and delete the project registry. Deleting a project with bookings is blocked.'
            : 'Create and rename projects. Deleting requires the account owner.'
        }
        action={
          <Dialog
            trigger={
              <Button size="sm" className="min-h-11">
                <LuPlus className="mr-1 h-4 w-4" /> New project
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

      {projectsQuery.isLoading ? (
        <Skeleton variant="table" />
      ) : projects.length === 0 ? (
        <div className="border-border rounded-lg border p-10 text-center text-sm">
          No projects yet. Create the first one above.
        </div>
      ) : (
        <ProjectTable
          projects={projects}
          isOwner={isOwner}
          selfId={user.id}
          onEdit={setEditTarget}
          onDelete={setDeleteTarget}
        />
      )}

      {/* Edit dialog - one per open state (controlled) */}
      <Dialog
        trigger={<span hidden />}
        header={{ title: 'Edit project' }}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        {editTarget !== null ? (
          <ProjectFormBody
            mode="edit"
            project={editTarget}
            onDone={() => setEditTarget(null)}
          />
        ) : null}
      </Dialog>

      {/* Delete confirm - owner-only */}
      <Dialog
        trigger={<span hidden />}
        header={{ title: 'Delete project' }}
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        {deleteTarget !== null ? (
          <ProjectDeleteBody
            project={deleteTarget}
            onDone={() => setDeleteTarget(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function ProjectTable({
  projects,
  isOwner,
  selfId,
  onEdit,
  onDelete,
}: {
  projects: ProjectListItem[];
  isOwner: boolean;
  selfId: string;
  onEdit: (project: ProjectListItem) => void;
  onDelete: (project: ProjectListItem) => void;
}) {
  const router = useRouter();
  return (
    <div className="border-border overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-border bg-muted/40 border-b text-left">
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Name</th>
            <th className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase">Slug</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase md:table-cell">
              RERA
            </th>
            <th className="hidden px-4 py-2.5 text-xs font-medium tracking-wide uppercase md:table-cell">
              CMDA
            </th>
            <th className="px-4 py-2.5 text-right text-xs font-medium tracking-wide uppercase">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id} className="border-border border-b last:border-b-0">
              <td className="px-4 py-2.5 font-medium" data-qa="project-row-name">
                {project.name}
                {project.slug === 'shadhil-metro-heights' ? (
                  <span className="text-muted-foreground ml-2 text-xs">
                    default
                  </span>
                ) : null}
              </td>
              <td className="text-muted-foreground px-4 py-2.5">{project.slug}</td>
              <td className="text-muted-foreground hidden px-4 py-2.5 md:table-cell">
                {project.reraNumber ?? '—'}
              </td>
              <td className="text-muted-foreground hidden px-4 py-2.5 md:table-cell">
                {project.cmdaNumber ?? '—'}
              </td>
              <td className="px-4 py-2.5 text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${project.name}`}
                  data-qa={`project-edit-${project.slug}`}
                  className="size-8"
                  onClick={() => onEdit(project)}
                >
                  <LuPencil className="size-4" />
                </Button>
                {isOwner && selfId !== '' ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${project.name}`}
                    data-qa={`project-delete-${project.slug}`}
                    className="text-destructive size-8"
                    onClick={() => onDelete(project)}
                  >
                    <LuTrash2 className="size-4" />
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-muted-foreground px-4 py-3 text-xs">
        Opening a project&apos;s work surface:
        {' '}
        <button
          type="button"
          className="text-foreground underline underline-offset-2"
          onClick={() => {
            const first = projects[0];
            if (first) void router.push(projectHref(first.id, '/dashboard'));
          }}
        >
          go to dashboard
        </button>
      </p>
    </div>
  );
}

