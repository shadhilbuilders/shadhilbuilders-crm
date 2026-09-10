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
  Combobox,
  Form,
  Item,
  ItemGroup,
  toast,
  TypographyP,
} from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import z from 'zod';

import { CreateProjectDtoSchema } from '@shadhil/api-types';
import {
  useCreateProject,
  useDeleteProject,
  useLinkProjectMember,
  useProjectMembers,
  useUnlinkProjectMember,
  useUpdateProject,
  useUsers,
  type ProjectListItem,
  type ProjectMemberRow,
} from '@/hooks/queries';
import { labelFor } from '@/lib/labels';

// ---------------------------------------------------------------------------
// Create / edit form body (rule 7c: separately exported component).
// Rebuilt on the <Form> component + zod validation (autoplan 2026-09-10),
// mirroring users/page.tsx. Server validation is the source of truth: the
// resolver runs CreateProjectDtoSchema (name/address required, RERA/CMDA
// optional, max lengths), and the mutation payload maps empty RERA/CMDA to
// omitted (create) or null (edit).
// ---------------------------------------------------------------------------

type ProjectFormValues = z.infer<typeof CreateProjectDtoSchema>;

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
    resolver: zodResolver(CreateProjectDtoSchema),
    defaultValues: {
      name: project?.name ?? '',
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
          ...(values.reraNumber !== undefined &&
          values.reraNumber.trim().length > 0
            ? { reraNumber: values.reraNumber.trim() }
            : {}),
          ...(values.cmdaNumber !== undefined &&
          values.cmdaNumber.trim().length > 0
            ? { cmdaNumber: values.cmdaNumber.trim() }
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
        name: values.name.trim(),
        address: values.address.trim(),
        reraNumber:
          values.reraNumber !== undefined &&
          values.reraNumber.trim().length > 0
            ? values.reraNumber.trim()
            : null,
        cmdaNumber:
          values.cmdaNumber !== undefined &&
          values.cmdaNumber.trim().length > 0
            ? values.cmdaNumber.trim()
            : null,
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
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={pending}
        >
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
        toast.error(
          error instanceof Error ? error.message : 'Delete failed',
        );
      },
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <TypographyP>
        Delete <strong>{project.name}</strong>? This soft-deletes the project:
        it's hidden from the registry/switcher and the per-project pages. Its
        leads and records are kept (not erased).
      </TypographyP>
      <TypographyP className="text-muted-foreground text-xs">
        Projects with bookings cannot be deleted - the server refuses with
        409. Only ADMIN or OWNER can delete.
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
          {deleteProject.isPending ? 'Deleting...' : 'Delete project'}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Manage members body - link existing users to a project, list, remove
// ---------------------------------------------------------------------------

/**
 * A single member row in the Manage-staff dialog. Owning its own unlink state
 * means only THIS row shows the "Unlinking..." loading state when its Unlink
 * button is clicked — the shared `useUnlinkProjectMember(...).isPending`
 * would otherwise spin every row's button at once.
 */
function ProjectMemberItem({
  project,
  member,
  canManage,
}: {
  project: ProjectListItem;
  member: ProjectMemberRow;
  /** MANAGER/ADMIN/OWNER → unlink enabled; staff (TELECALLER/SALES_EXEC) → view only. */
  canManage: boolean;
}) {
  const unlinkMember = useUnlinkProjectMember(project.id);
  const [unlinking, setUnlinking] = useState(false);

  function handleUnlink() {
    setUnlinking(true);
    unlinkMember.mutate(member.userId, {
      onSuccess: () => {
        toast.success(`${member.name} removed from ${project.name}`);
      },
      onError: (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Remove failed');
      },
      onSettled: () => setUnlinking(false),
    });
  }

  return (
    <Item
      variant="outline"
      size="sm"
      title={member.name}
      description={`${labelFor('role', member.role)} · ${member.email}${
        member.isLeadOwner ? ' · via leads' : ''
      }`}
      actions={
        canManage ? (
          <Button
            type="button"
            variant="ghost"
            color="danger"
            size="sm"
            onClick={handleUnlink}
            disabled={unlinking}
            isLoading={unlinking}
            loadingText="Unlinking..."
            data-qa={`project-member-unlink-${member.userId}`}
          >
            Unlink
          </Button>
        ) : null
      }
    />
  );
}

/**
 * Manage a project's working staff. Admin/owner surface: link an existing
 * user (TELECALLER / SALES_EXEC / MANAGER) to this project via a searchable
 * Combobox, list current members, and unlink. Backed by
 * POST/DELETE/GET /api/projects/:id/members.
 *
 * Semantics (autoplan 2026-09-09, client-confirmed "both"):
 *   - The list is the effective staff = explicit members UNION lead-owners.
 *   - Rows inferred from lead ownership are marked "via leads" (isLeadOwner).
 */
export function ProjectMembersBody({
  project,
  canManage,
  onDone,
}: {
  project: ProjectListItem;
  /** MANAGER/ADMIN/OWNER → can link/unlink members; staff (TELECALLER/SALES_EXEC) → view only. */
  canManage: boolean;
  onDone: () => void;
}) {
  const membersQuery = useProjectMembers(project.id);
  const linkMember = useLinkProjectMember(project.id);

  // All candidate users the admin could link - staff roles only (you can't
  // link an ADMIN/OWNER's "work" on a project in this model).
  const usersQuery = useUsers({ limit: 200 });
  const members = membersQuery.data ?? [];
  const memberIds = useMemo(
    () => new Set(members.map((m) => m.userId)),
    [members],
  );

  // Candidates = staff users not already a member of this project.
  const candidates = useMemo(() => {
    const rows = usersQuery.data?.rows ?? [];
    return rows
      .filter(
        (u) =>
          !memberIds.has(u.id) &&
          (u.role === 'TELECALLER' ||
            u.role === 'SALES_EXEC' ||
            u.role === 'MANAGER'),
      )
      .map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }));
  }, [usersQuery.data, memberIds]);

  // Link picker is a <Form> with a native 'combobox' field (autoplan
  // 2026-09-10). Selecting a user and submitting links them; on success the
  // field resets so the same user can't be double-linked.
  const linkForm = useForm<{ userId: string }>({
    defaultValues: { userId: '' },
    mode: 'onSubmit',
  });

  function onLink(values: { userId: string }) {
    if (values.userId.length === 0) return;
    linkMember.mutate(values.userId, {
      onSuccess: (row) => {
        toast.success(`${row.name} linked to ${project.name}`);
        linkForm.reset();
      },
      onError: (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'Link failed');
      },
    });
  }

  const linkFields: FormFieldItemType<{ userId: string }>[] = [
    {
      type: 'custom',
      name: 'userId',
      label: 'Link a user',
      render: ({ field }) => (
        <div className="flex items-end gap-2">
          <Combobox
            value={(field.value as string | undefined) ?? ''}
            onValueChange={(v) => field.onChange(v ?? '')}
            options={candidates}
            placeholder={
              candidates.length === 0
                ? 'No more users to link'
                : 'Search staff to link...'
            }
            disabled={candidates.length === 0}
            selectOptionAsValue
            className="min-w-0 flex-1"
            data-qa="project-member-picker"
          />
          <Button
            type="submit"
            form="link-member-form"
            disabled={
              !field.value ||
              linkMember.isPending ||
              candidates.length === 0
            }
            isLoading={linkMember.isPending}
            loadingText="Linking..."
            data-qa="project-member-link"
            className="shrink-0"
          >
            Link
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <TypographyP className="text-muted-foreground text-sm">
        Link staff to <strong className="text-foreground">{project.name}</strong>,
        or remove them. Members appear across pickers (e.g. schedule-visit).
      </TypographyP>

      {/* Link a user (manager/admin/owner only) - <Form> wrapping the combobox;
          the Add button lives side-by-side inside the custom field render */ }
      {canManage ? (
        <Form
          id="link-member-form"
          form={linkForm}
          onSubmit={onLink}
          hideResetButton
          hideSubmitButton
          fields={linkFields}
        />
      ) : null}

      {/* Member list - ItemGroup/Item from @paalstack/react-ui */}
      {membersQuery.isLoading ? (
        <TypographyP className="text-muted-foreground text-sm">
          Loading members...
        </TypographyP>
      ) : members.length === 0 ? (
        <TypographyP className="text-muted-foreground text-sm">
          No staff linked to this project yet.
        </TypographyP>
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
          <ItemGroup className="gap-3">
            {members.map((member) => (
              <ProjectMemberItem
                key={member.userId}
                project={project}
                member={member}
                canManage={canManage}
              />
            ))}
          </ItemGroup>
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}