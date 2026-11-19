'use client';

// Project create/edit/delete dialog bodies - T-ProjectSwitch (2026-09-05).
// Extracted from app/(app)/projects/page.tsx (rule 7c + Next's strict
// page-export constraint): the Dialog wrapper is a shell; these bodies
// are the testable contract.
//
// Create → POST /api/projects (ADMIN/OWNER; slug derived from the name).
// Edit   → PATCH /api/projects/:id (ADMIN/OWNER; slug editable since
//          2026-11-19 - it is the URL segment, so it is shown as a field).
// Delete → DELETE /api/projects/:id (OWNER only; 409 when bookings exist).

import { Button, Form, toast, TypographyP } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import z from 'zod';

import { CreateProjectDtoSchema, ProjectSlugSchema } from '@shadhil/api-types';
import {
  useCreateProject,
  useDeleteProject,
  useUpdateProject,
  type ProjectListItem,
} from '@/hooks/queries';

// ---------------------------------------------------------------------------
// Create / edit form body (rule 7c: separately exported component).
// Rebuilt on the <Form> component + zod validation (autoplan 2026-09-10),
// mirroring users/page.tsx. Server validation is the source of truth: the
// resolver runs CreateProjectDtoSchema (name/address required, RERA/CMDA
// optional, max lengths), and the mutation payload maps empty RERA/CMDA to
// omitted (create) or null (edit).
// ---------------------------------------------------------------------------

// The edit dialog also exposes the slug, so the form schema is the create DTO
// plus an optional slug validated by the shared ProjectSlugSchema - the same
// rule the backend enforces. Create mode never sends it.
const ProjectFormSchema = CreateProjectDtoSchema.extend({ slug: ProjectSlugSchema.optional() });

type ProjectFormValues = z.infer<typeof ProjectFormSchema>;

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

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(ProjectFormSchema),
    defaultValues: {
      name: project?.name ?? '',
      slug: project?.slug ?? '',
      address: project?.address ?? '',
      reraNumber: project?.reraNumber ?? '',
      cmdaNumber: project?.cmdaNumber ?? '',
    },
    mode: 'onSubmit',
  });

  function onSubmit(values: ProjectFormValues) {
    if (mode === 'create') {
      createProject.mutate(
        {
          name: values.name.trim(),
          address: values.address.trim(),
          ...(values.reraNumber !== undefined && values.reraNumber.trim().length > 0
            ? { reraNumber: values.reraNumber.trim() }
            : {}),
          ...(values.cmdaNumber !== undefined && values.cmdaNumber.trim().length > 0
            ? { cmdaNumber: values.cmdaNumber.trim() }
            : {}),
        },
        {
          onSuccess: (created) => {
            toast.success(`Project ${created.name} created`);
            onDone();
          },
          onError: (error: unknown) => {
            toast.error(error instanceof Error ? error.message : 'Create failed');
          },
        },
      );
      return;
    }
    if (project === undefined) return;
    const nextSlug = values.slug?.trim() ?? '';
    // Send the slug only when it actually changed: the service 409s on a clash
    // and there is no reason to rewrite the same value into the audit row.
    const slugPatch = nextSlug.length > 0 && nextSlug !== project.slug ? { slug: nextSlug } : {};
    updateProject.mutate(
      {
        id: project.id,
        ...slugPatch,
        name: values.name.trim(),
        address: values.address.trim(),
        reraNumber:
          values.reraNumber !== undefined && values.reraNumber.trim().length > 0
            ? values.reraNumber.trim()
            : null,
        cmdaNumber:
          values.cmdaNumber !== undefined && values.cmdaNumber.trim().length > 0
            ? values.cmdaNumber.trim()
            : null,
      },
      {
        onSuccess: (updated) => {
          toast.success(
            updated.slug === project.slug
              ? `Project ${updated.name} updated`
              : `Project ${updated.name} updated - its pages moved to /${updated.slug}`,
          );
          onDone();
        },
        onError: (error: unknown) => {
          toast.error(error instanceof Error ? error.message : 'Update failed');
        },
      },
    );
  }

  const fields: FormFieldItemType<ProjectFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Project Name',
      required: true,
      placeholder: 'e.g. Shadhil Skyline Towers',
      inputProps: {
        maxLength: 120,
        'data-qa': 'project-form-name',
      },
    },
    // Slug only exists once a project does: create derives it from the name.
    ...(mode === 'edit'
      ? [
          {
            type: 'input' as const,
            name: 'slug' as const,
            label: 'URL slug',
            description:
              'The address of every page for this project. Changing it moves those URLs - old links stop working.',
            placeholder: 'e.g. shadhil-metro-heights',
            inputProps: {
              maxLength: 80,
              autoCapitalize: 'none',
              spellCheck: false,
              'data-qa': 'project-form-slug',
            },
          },
        ]
      : []),
    {
      type: 'input',
      name: 'address',
      label: 'Address',
      required: true,
      placeholder: 'e.g. Whitefield, Bengaluru',
      inputProps: {
        maxLength: 500,
        'data-qa': 'project-form-address',
      },
    },
    {
      type: 'input',
      name: 'reraNumber',
      label: 'RERA Number',
      description: 'Optional - from the RERA certificate (TN/02/XXXX/YYYY).',
      placeholder: 'TN/02/2024/0001',
      inputProps: {
        maxLength: 64,
        'data-qa': 'project-form-rera',
      },
    },
    {
      type: 'input',
      name: 'cmdaNumber',
      label: 'CMDA Number',
      description: 'Optional - plan approval number.',
      placeholder: 'e.g. PP/2024/BLR/123',
      inputProps: {
        maxLength: 64,
        'data-qa': 'project-form-cmda',
      },
    },
  ];

  // Reuse the mutation error (create or update) as an inline message.
  const mutationError = createProject.error ?? updateProject.error;
  const actionLabel = mode === 'create' ? 'Create project' : 'Save changes';

  return (
    <div className="space-y-3">
      <Form
        id="project-form"
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
      {mutationError instanceof Error ? (
        <p className="text-destructive text-xs">{mutationError.message}</p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="project-form"
          isLoading={pending}
          loadingText="Saving..."
          data-qa="project-form-submit"
        >
          {pending ? 'Saving...' : actionLabel}
        </Button>
      </div>
    </div>
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
        toast.success(`Project ${project.name} soft-deleted`);
        onDone();
        // The deleted project may be the URL's active one; bounce to a
        // safe surface.
        void router.push('/');
      },
      onError: (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Delete failed');
      },
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <TypographyP>
        Delete <strong>{project.name}</strong>? This soft-deletes the project: it's hidden from the
        registry/switcher and the per-project pages. Its leads and records are kept (not erased).
      </TypographyP>
      <TypographyP className="text-muted-foreground text-xs">
        Projects with bookings cannot be deleted - the server refuses with 409. Only ADMIN or OWNER
        can delete.
      </TypographyP>
      {deleteProject.isError && deleteProject.error instanceof Error ? (
        <p className="text-destructive text-xs">{deleteProject.error.message}</p>
      ) : null}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={deleteProject.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="destructive"
          disabled={deleteProject.isPending}
          data-qa="project-delete-confirm"
        >
          {deleteProject.isPending ? 'Deleting...' : 'Delete project'}
        </Button>
      </div>
    </form>
  );
}
