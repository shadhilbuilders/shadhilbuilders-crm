'use client';

// Project create/edit/delete dialog bodies - T-ProjectSwitch (2026-09-05).
// Extracted from app/(app)/projects/page.tsx (rule 7c + Next's strict
// page-export constraint): the Dialog wrapper is a shell; these bodies
// are the testable contract.
//
// Create → POST /api/projects (ADMIN/OWNER; slug derived server-side).
// Edit   → PATCH /api/projects/:id (ADMIN/OWNER; slug immutable).
// Delete → DELETE /api/projects/:id (OWNER only; 409 when bookings exist).

import {
  Button,
  Field,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import {
  useCreateProject,
  useDeleteProject,
  useUpdateProject,
  type ProjectListItem,
} from '@/hooks/queries';

// ---------------------------------------------------------------------------
// Create / edit form body (rule 7c: separately exported component)
// ---------------------------------------------------------------------------

export function ProjectFormBody({
  mode,
  project,
  onDone,
}: {
  mode: 'create' | 'edit';
  project?: ProjectListItem;
  onDone: () => void;
}) {
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const pending = createProject.isPending || updateProject.isPending;

  const [name, setName] = useState(project?.name ?? '');
  const [address, setAddress] = useState(project?.address ?? '');
  const [reraNumber, setReraNumber] = useState(project?.reraNumber ?? '');
  const [cmdaNumber, setCmdaNumber] = useState(project?.cmdaNumber ?? '');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === 'create') {
      createProject.mutate(
        {
          name: name.trim(),
          address: address.trim(),
          ...(reraNumber.trim().length > 0
            ? { reraNumber: reraNumber.trim() }
            : {}),
          ...(cmdaNumber.trim().length > 0
            ? { cmdaNumber: cmdaNumber.trim() }
            : {}),
        },
        {
          onSuccess: (created) => {
            toast.success(`Project ${created.name} created`);
            onDone();
          },
          onError: (error: unknown) => {
            toast.error(
              error instanceof Error ? error.message : 'Create failed',
            );
          },
        },
      );
      return;
    }
    if (project === undefined) return;
    updateProject.mutate(
      {
        id: project.id,
        name: name.trim(),
        address: address.trim(),
        reraNumber: reraNumber.trim().length > 0 ? reraNumber.trim() : null,
        cmdaNumber: cmdaNumber.trim().length > 0 ? cmdaNumber.trim() : null,
      },
      {
        onSuccess: (updated) => {
          toast.success(`Project ${updated.name} updated`);
          onDone();
        },
        onError: (error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : 'Update failed',
          );
        },
      },
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <Field label="Project name">
        <input
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          required
          maxLength={120}
          data-qa="project-form-name"
          className="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </Field>
      <Field label="Address">
        <input
          value={address}
          onChange={(event) => setAddress(event.currentTarget.value)}
          required
          maxLength={500}
          data-qa="project-form-address"
          className="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      </Field>
      <Field
        label="RERA number"
        description="Optional - from the RERA certificate (TN/02/XXXX/YYYY)."
      >
        <input
          value={reraNumber}
          onChange={(event) => setReraNumber(event.currentTarget.value)}
          maxLength={64}
          data-qa="project-form-rera"
          className="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      </Field>
      <Field
        label="CMDA number"
        description="Optional - plan approval number."
      >
        <input
          value={cmdaNumber}
          onChange={(event) => setCmdaNumber(event.currentTarget.value)}
          maxLength={64}
          data-qa="project-form-cmda"
          className="border-input bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
        />
      </Field>
      {(createProject.isError || updateProject.isError) &&
      (createProject.error ?? updateProject.error) instanceof Error ? (
        <p className="text-destructive text-xs">
          {(createProject.error ?? updateProject.error)!.message}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onDone}
          disabled={pending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={pending || name.trim().length === 0}>
          {pending
            ? 'Saving…'
            : mode === 'create'
              ? 'Create project'
              : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm body (owner-only; server 409s when bookings exist)
// ---------------------------------------------------------------------------

export function ProjectDeleteBody({
  project,
  onDone,
}: {
  project: ProjectListItem;
  onDone: () => void;
}) {
  const deleteProject = useDeleteProject();
  const router = useRouter();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    deleteProject.mutate(project.id, {
      onSuccess: () => {
        toast.success(`Project ${project.name} deleted`);
        onDone();
        // The deleted project may be the URL's active one; bounce to a
        // safe surface.
        void router.push('/');
      },
      onError: (error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : 'Delete failed',
        );
      },
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <TypographyP>
        Delete <strong>{project.name}</strong>? Its leads stay in the CRM
        (unassigned from the project). This cannot be undone.
      </TypographyP>
      <TypographyP className="text-muted-foreground text-xs">
        Projects with bookings cannot be deleted - the server refuses with
        409. Only the account owner can delete.
      </TypographyP>
      {deleteProject.isError && deleteProject.error instanceof Error ? (
        <p className="text-destructive text-xs">{deleteProject.error.message}</p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onDone}
          disabled={deleteProject.isPending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={deleteProject.isPending}
          data-qa="project-delete-confirm"
        >
          {deleteProject.isPending ? 'Deleting…' : 'Delete project'}
        </Button>
      </div>
    </form>
  );
}