'use client';

// LeadCoOwnerDialog - set, change, or clear a lead's co-owner (manager →
// teammate, or admin → any assignable user). Triggered from the lead detail
// action panel (LeadActionPanel).
//
// Mirrors LeadReassignDialog: uses the props-API `<Form>` (react-hook-form +
// zodResolver) with a native `type: 'combobox'` field that lists 10 assignable
// users by DEFAULT (via useUsers({ limit: 10 })), then switches to a REMOTE
// autosuggest fetch (GET /api/users?search=&limit=10, debounced) once the
// user types. The users endpoint is server-scoped by the actor: MANAGER →
// own team only; ADMIN/OWNER → all. We additionally filter client-side to
// the assignable roles + exclude the lead owner. A "Clear co-owner" option is
// offered when a co-owner is already set.
//
// A required `reason` field drives the audit trail. coOwnerId=null clears.
import { Button, Dialog, Form, FormFieldItemType, toast } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { api, qs, type Role } from '@/apis/client';
import { useSetLeadCoOwner } from '@/hooks/queries/crm';
import { useProjectId } from '@/lib/tenant-context';
import { useUsers } from '@/hooks/queries/users';
import { isLinkableStaffRole } from '@/lib/session';

const FORM_ID = 'lead-co-owner-form';

/** Minimal lead we set a co-owner on. */
export type LeadCoOwnerTarget = {
  id: string;
  name: string;
  /** Current owner - excluded from the co-owner picker. */
  ownerId: string;
  /** The lead's project, so the picker offers only THAT project's staff. */
  projectId?: string | null;
};

export type LeadCoOwnerDialogProps = {
  lead: LeadCoOwnerTarget | null;
  /** Current co-owner id (null when none set) - shown as the preselect. */
  currentCoOwnerId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const coOwnerSchema = z.object({
  assignee: z.string().min(1, 'Select a staff member (or Clear co-owner)'),
  reason: z
    .string()
    .trim()
    .min(1, 'A reason is required for the audit trail')
    .max(500, 'Reason must be 500 characters or fewer'),
});
type CoOwnerFormValues = z.infer<typeof coOwnerSchema>;

async function fetchCoOwners(
  query: string,
  ownerId: string,
  projectId: string | null,
): Promise<Array<{ value: string; label: string }>> {
  const q = query.trim();
  const res = await api<{
    rows: Array<{ id: string; name: string; email: string; role: Role }>;
  }>(
    // projectId narrows the remote search to the lead's own project staff
    // (T-USER-PROJECT-SCOPE).
    `/users${qs({
      search: q.length > 0 ? q : undefined,
      projectId: projectId ?? undefined,
      limit: 10,
    })}`,
  );
  return (res.rows ?? [])
    .filter((u) => u.id !== ownerId && isLinkableStaffRole(u.role))
    .map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }));
}

export function CoOwnerFormBody({
  ownerId,
  projectId,
  onSubmit,
}: {
  ownerId: string;
  projectId: string | null;
  onSubmit: (values: CoOwnerFormValues) => void;
}) {
  const form = useForm<CoOwnerFormValues>({
    resolver: zodResolver(coOwnerSchema),
    defaultValues: { assignee: '', reason: '' },
    mode: 'onSubmit',
  });

  const fetchBound = (query: string) => fetchCoOwners(query, ownerId, projectId);

  // T-USER-PROJECT-SCOPE: scoped to the lead's project (see LeadReassignDialog).
  const { data: defaultUsers } = useUsers({ limit: 10, projectId: projectId ?? undefined });
  const defaultOptions = useMemo(
    () =>
      (defaultUsers?.rows ?? [])
        .filter((u) => u.id !== ownerId && isLinkableStaffRole(u.role))
        .map((u) => ({ value: u.id, label: `${u.name} (${u.email})` })),
    [defaultUsers, ownerId],
  );

  const fields: FormFieldItemType<CoOwnerFormValues>[] = [
    {
      type: 'combobox' as const,
      name: 'assignee' as const,
      label: 'Co-owner',
      required: true,
      placeholder: 'Search staff by name or email...',
      options: defaultOptions,
      description:
        'A second staff member who can work the lead. Only telecallers / sales executives on this project. Start typing to search them.',
      comboboxProps: {
        fetchOptions: fetchBound,
        fetchDebounce: 300,
        loadingMessage: 'Searching staff...',
        emptyOptionMessage: 'No assignable staff found.',
        selectOptionAsValue: true,
        'data-qa': 'lead-co-owner-assignee',
        className: 'min-w-0',
      },
    },
    {
      type: 'textarea' as const,
      name: 'reason' as const,
      label: 'Reason',
      required: true,
      placeholder: 'e.g. adding the sales executive to follow up the site visit',
      textareaProps: {
        rows: 2,
        maxLength: 500,
        'data-qa': 'lead-co-owner-reason',
      },
      description: 'Required - recorded in the audit trail.',
    },
  ];

  return (
    <Form<CoOwnerFormValues>
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      hideSubmitButton
      hideResetButton
      fields={fields}
    />
  );
}

export function LeadCoOwnerDialog({
  lead,
  currentCoOwnerId,
  open,
  onOpenChange,
}: LeadCoOwnerDialogProps) {
  const setCoOwner = useSetLeadCoOwner();
  const activeProjectId = useProjectId();

  if (lead === null) return null;
  const target = lead;
  const hasCoOwner = typeof currentCoOwnerId === 'string' && currentCoOwnerId.length > 0;

  function handleSubmit(values: CoOwnerFormValues) {
    setCoOwner.mutate(
      {
        leadId: target.id,
        coOwnerId: values.assignee || null,
        reason: values.reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success(hasCoOwner === false || values.assignee ? 'Co-owner updated' : 'Co-owner cleared');
          onOpenChange(false);
        },
        onError: (error) => {
          const msg = error instanceof Error ? error.message : 'Update failed';
          toast.error(msg);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="sm:max-w-md"
      header={{
        title: `Set co-owner for "${target.name}"`,
        description: hasCoOwner
          ? 'Add a new co-owner, or clear the current one.'
          : 'Add a second staff member to work alongside the owner.',
      }}
      footer={
        <div className="flex w-full justify-end gap-2">
          {hasCoOwner ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCoOwner.mutate(
                  { leadId: target.id, coOwnerId: null, reason: 'Clearing co-owner' },
                  {
                    onSuccess: () => {
                      toast.success('Co-owner cleared');
                      onOpenChange(false);
                    },
                    onError: (error) =>
                      toast.error(error instanceof Error ? error.message : 'Update failed'),
                  },
                );
              }}
              disabled={setCoOwner.isPending}
              data-qa="lead-co-owner-clear"
            >
              Clear co-owner
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={setCoOwner.isPending}
            data-qa="lead-co-owner-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={setCoOwner.isPending}
            loadingText="Saving..."
            data-qa="lead-co-owner-confirm"
          >
            Save co-owner
          </Button>
        </div>
      }
    >
      <CoOwnerFormBody
        ownerId={target.ownerId}
        projectId={target.projectId ?? activeProjectId}
        onSubmit={handleSubmit}
      />
    </Dialog>
  );
}
