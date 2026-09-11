'use client';

// LeadReassignDialog - assign a lead to another staff member (manager →
// teammate, or admin → any assignable user). Triggered from BOTH:
//   - the lead detail action panel (LeadActionPanel), and
//   - the lead inbox row actions (LeadRowActions).
//
// Uses the props-API `<Form>` (react-hook-form + zodResolver) with:
//   - a native `type: 'combobox'` field that lists 10 assignable users by
//     DEFAULT (shown on open) via `useUsers({ limit: 10 })`, then switches
//     to a REMOTE autosuggest fetch (GET /api/users?search=&limit=10,
//     debounced) once the user types. The users endpoint is server-scoped by
//     the actor: MANAGER → own team only; ADMIN/OWNER → all. We additionally
//     filter client-side to the only assignable roles (TELECALLER/SALES_EXEC)
//     and exclude the current owner.
//   - a `type: 'textarea'` reason field. `reason` is REQUIRED by
//     ReassignLeadDto (drives the audit trail + manager visibility).
//
// Form validation is zod (both fields) - validation errors render inline
// under the fields; the mutation lives in the Dialog shell (the footer
// button's isLoading). Mirrors LeadEditDialog / ConvertFormBody.
import { Button, Dialog, Form, FormFieldItemType, toast } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { api, qs, type Role } from '@/apis/client';
import { useReassignLead } from '@/hooks/queries/crm';
import { useUsers } from '@/hooks/queries/users';
import { isLinkableStaffRole } from '@/lib/session';

const FORM_ID = 'lead-reassign-form';

/** Minimal lead we reassign (from either the inbox row or the detail). */
export type LeadReassignTarget = {
  id: string;
  name: string;
};

export type LeadReassignDialogProps = {
  lead: LeadReassignTarget | null;
  /** The lead's current owner id - excluded from the assignee picker. */
  currentOwnerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// ---------------------------------------------------------------------------
// Zod schema (client-side; mirrors ReassignLeadDto + the service's guards)
// ---------------------------------------------------------------------------
const reassignSchema = z.object({
  assignee: z.string().min(1, 'Select a staff member to assign to'),
  reason: z
    .string()
    .trim()
    .min(1, 'A reason is required for the audit trail')
    .max(500, 'Reason must be 500 characters or fewer'),
});
type ReassignFormValues = z.infer<typeof reassignSchema>;

// ---------------------------------------------------------------------------
// Remote-autosuggest assignee fetch
// ---------------------------------------------------------------------------
// The actor's `/api/users?search=` call is server-scoped to their own team
// (MANAGER) or everyone (ADMIN/OWNER). We restrict to assignable staff roles
// and drop the current owner. The server re-enforces all of this.
async function fetchAssignees(
  query: string,
  currentOwnerId: string,
): Promise<Array<{ value: string; label: string }>> {
  const q = query.trim();
  const res = await api<{
    rows: Array<{ id: string; name: string; email: string; role: Role }>;
  }>(`/users${qs({ search: q.length > 0 ? q : undefined, limit: 10 })}`);
  return (res.rows ?? [])
    .filter((u) => u.id !== currentOwnerId && isLinkableStaffRole(u.role))
    .map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }));
}

// ---------------------------------------------------------------------------
// Form body (exported for tests - jsdom portal rule: render THIS)
// ---------------------------------------------------------------------------
export function LeadReassignFormBody({
  currentOwnerId,
  onSubmit,
}: {
  currentOwnerId: string;
  onSubmit: (values: ReassignFormValues) => void;
}) {
  const form = useForm<ReassignFormValues>({
    resolver: zodResolver(reassignSchema),
    defaultValues: { assignee: '', reason: '' },
    mode: 'onSubmit',
  });

  const fetchAssigneesBound = (query: string) => fetchAssignees(query, currentOwnerId);

  // Default list shown when the picker opens (no typing yet): the first 10
  // staff, filtered to assignable roles + not the current owner. Once the
  // user types, fetchOptions takes over (remote search). Mirrors the
  // project member picker pattern.
  const { data: defaultUsers } = useUsers({ limit: 10 });
  const defaultOptions = useMemo(() => {
    return (defaultUsers?.rows ?? [])
      .filter((u) => u.id !== currentOwnerId && isLinkableStaffRole(u.role))
      .map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }));
  }, [defaultUsers, currentOwnerId]);

  const fields: FormFieldItemType<ReassignFormValues>[] = [
    {
      type: 'combobox' as const,
      name: 'assignee' as const,
      label: 'Assign to',
      required: true,
      placeholder: 'Search staff by name or email...',
      options: defaultOptions,
      description:
        'Only telecallers / sales executives in your team are assignable. Start typing to search all users.',
      comboboxProps: {
        fetchOptions: fetchAssigneesBound,
        fetchDebounce: 300,
        loadingMessage: 'Searching staff...',
        emptyOptionMessage: 'No assignable staff found.',
        selectOptionAsValue: true,
        'data-qa': 'lead-reassign-assignee',
        className: 'min-w-0',
      },
    },
    {
      type: 'textarea' as const,
      name: 'reason' as const,
      label: 'Reason',
      required: true,
      placeholder: 'e.g. handing off to the sales executive for site-visit follow-up',
      textareaProps: {
        rows: 2,
        maxLength: 500,
        'data-qa': 'lead-reassign-reason',
      },
      description: 'Required - recorded in the audit trail.',
    },
  ];

  return (
    <Form<ReassignFormValues>
      id={FORM_ID}
      form={form}
      onSubmit={onSubmit}
      hideSubmitButton
      hideResetButton
      fields={fields}
    />
  );
}

// ---------------------------------------------------------------------------
// Dialog shell (owns the mutation + footer)
// ---------------------------------------------------------------------------
export function LeadReassignDialog({
  lead,
  currentOwnerId,
  open,
  onOpenChange,
}: LeadReassignDialogProps) {
  const reassign = useReassignLead();

  if (lead === null) return null;
  const target = lead;

  function handleSubmit(values: ReassignFormValues) {
    reassign.mutate(
      { leadId: target.id, targetUserId: values.assignee, reason: values.reason.trim() },
      {
        onSuccess: () => {
          toast.success('Lead reassigned');
          onOpenChange(false);
        },
        onError: (error) => {
          // Server guard messages (403 team/role, 400 state-lane) arrive
          // verbatim from the BFF.
          const msg = error instanceof Error ? error.message : 'Reassign failed';
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
        title: `Assign "${target.name}"`,
        description:
          'Move ownership to another staff member. A reason is required for the audit trail.',
      }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={reassign.isPending}
            data-qa="lead-reassign-cancel"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            isLoading={reassign.isPending}
            loadingText="Assigning..."
            data-qa="lead-reassign-confirm"
          >
            Assign
          </Button>
        </div>
      }
    >
      <LeadReassignFormBody
        currentOwnerId={currentOwnerId}
        onSubmit={handleSubmit}
      />
    </Dialog>
  );
}
