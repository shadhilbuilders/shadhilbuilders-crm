'use client';

// TeamMemberRemovalDialog - T-TEAM-AUTHORITATIVE (2026-09-13, design doc
// UI2). Preview + confirm + execute the team-scoped member-removal flow:
//   GET  /api/teams/:teamId/members/:userId/removal-preview
//   POST /api/teams/:teamId/members/:userId/reassign-and-remove
//
// Mirrors LeadReassignDialog's shape (Dialog shell owns the mutation +
// footer; the exported body is the testable contract - rule 7c), but adds
// the removal-preview's own loading/error/zero-lead/eligible-picker states
// on top, per the design doc's interaction-state matrix.
import { useEffect, useRef, useState } from 'react';
import {
  Button,
  Combobox,
  Dialog,
  Form,
  toast,
  TypographyMuted,
  TypographyP,
} from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { ApiError } from '@/apis/client';
import {
  useReassignAndRemove,
  useRemovalPreview,
  type ReassignAndRemoveInput,
} from '@/hooks/queries/team-members';

const FORM_ID = 'team-member-removal-form';
const NO_REPLACEMENT = '';

export type TeamMemberRemovalTarget = {
  teamId: string;
  teamName: string;
  userId: string;
  userName: string;
};

export type TeamMemberRemovalDialogProps = {
  target: TeamMemberRemovalTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const removalSchema = z.object({
  replacementUserId: z.string(),
  reason: z
    .string()
    .trim()
    .min(1, 'A reason is required for the audit trail')
    .max(500, 'Reason must be 500 characters or fewer'),
});
type RemovalFormValues = z.infer<typeof removalSchema>;

/**
 * Generates a fresh client requestId whenever the dialog transitions
 * closed -> open (design doc: "reopening the dialog creates a new one").
 * A STALE_PREVIEW retry keeps the SAME requestId - the dialog never closes
 * for that recovery path.
 */
function useDialogRequestId(open: boolean): string {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setRequestId(crypto.randomUUID());
    }
    wasOpen.current = open;
  }, [open]);
  return requestId;
}

export function TeamMemberRemovalDialog({
  target,
  open,
  onOpenChange,
}: TeamMemberRemovalDialogProps) {
  const requestId = useDialogRequestId(open);
  const preview = useRemovalPreview(target?.teamId, target?.userId, open);
  const execute = useReassignAndRemove(target?.teamId, target?.userId);
  const [staleNotice, setStaleNotice] = useState(false);
  const [replacementFieldError, setReplacementFieldError] = useState<string | null>(null);

  if (target === null) return null;
  const t = target;

  function handleClose(next: boolean): void {
    // Escape/overlay dismissal disabled only while submission is pending
    // (design doc) - Base UI calls onOpenChange(false) for every dismiss
    // request, so this one guard covers Escape, overlay click, and the
    // Cancel button uniformly.
    if (!next && execute.isPending) return;
    if (!next) {
      setStaleNotice(false);
      setReplacementFieldError(null);
    }
    onOpenChange(next);
  }

  function handleSubmit(values: RemovalFormValues): void {
    if (preview.data === undefined) return;
    setReplacementFieldError(null);
    const input: ReassignAndRemoveInput = {
      replacementUserId:
        values.replacementUserId === NO_REPLACEMENT ? null : values.replacementUserId,
      reason: values.reason.trim(),
      previewToken: preview.data.previewToken,
      requestId,
    };
    execute.mutate(input, {
      onSuccess: (result) => {
        const replacementName =
          preview.data?.eligibleReplacements.find((c) => c.userId === result.replacementUserId)
            ?.name ?? null;
        toast.success(
          result.transferredLeadCount > 0 && replacementName !== null
            ? `Removed ${t.userName} from ${t.teamName}; transferred ${result.transferredLeadCount} lead${result.transferredLeadCount === 1 ? '' : 's'} to ${replacementName}`
            : `Removed ${t.userName} from ${t.teamName}`,
        );
        setStaleNotice(false);
        onOpenChange(false);
      },
      onError: (error: unknown) => {
        if (error instanceof ApiError && error.code === 'STALE_PREVIEW') {
          setStaleNotice(true);
          void preview.refetch();
          return;
        }
        if (error instanceof ApiError && error.code === 'CONCURRENT_MEMBERSHIP_CHANGE') {
          toast.error(`${error.message} Close this dialog and reload.`);
          return;
        }
        // Design doc interaction-state matrix: SELF_REPLACEMENT,
        // TARGET_NOT_TEAM_MEMBER, TARGET_ROLE_INELIGIBLE render as an
        // inline field error on the replacement picker, not a toast.
        if (
          error instanceof ApiError &&
          error.code !== null &&
          (['SELF_REPLACEMENT', 'TARGET_NOT_TEAM_MEMBER', 'TARGET_ROLE_INELIGIBLE'] as const).includes(
            error.code as 'SELF_REPLACEMENT' | 'TARGET_NOT_TEAM_MEMBER' | 'TARGET_ROLE_INELIGIBLE',
          )
        ) {
          setReplacementFieldError(error.message);
          return;
        }
        toast.error(error instanceof Error ? error.message : 'Removal failed');
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={handleClose}
      contentClassName="sm:max-w-lg"
      header={{
        title: `Remove ${t.userName} from ${t.teamName}?`,
      }}
      footer={
        // Responsive/a11y contract (design doc UI5): on small screens the
        // footer stacks full-width with Cancel appearing BEFORE (above)
        // the destructive action, in DOM/visual order; on sm+ it's the
        // usual inline row (Cancel, then the primary action, right-aligned).
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleClose(false)}
            disabled={execute.isPending}
            className="w-full sm:w-auto"
            data-qa="team-member-removal-cancel"
          >
            Cancel
          </Button>
          <RemovalConfirmButton preview={preview.data} pending={execute.isPending} />
        </div>
      }
    >
      <TeamMemberRemovalDialogBody
        preview={preview}
        staleNotice={staleNotice}
        pending={execute.isPending}
        onSubmit={handleSubmit}
        replacementFieldError={replacementFieldError}
      />
    </Dialog>
  );
}

/** The footer's confirm button - label repeats the exact transfer count
 * (design doc: "Button repeats the exact transfer count"). */
function RemovalConfirmButton({
  preview,
  pending,
}: {
  preview: { totalAffectedLeads: number } | undefined;
  pending: boolean;
}) {
  const n = preview?.totalAffectedLeads ?? 0;
  const label =
    preview === undefined
      ? 'Remove'
      : n > 0
        ? `Transfer ${n} lead${n === 1 ? '' : 's'} and remove`
        : 'Remove from team';
  return (
    <Button
      type="submit"
      form={FORM_ID}
      variant="destructive"
      isLoading={pending}
      loadingText="Transferring..."
      disabled={preview === undefined || pending}
      className="w-full sm:w-auto"
      data-qa="team-member-removal-confirm"
      aria-describedby="team-member-removal-summary"
    >
      {label}
    </Button>
  );
}

/**
 * The dialog's body - exported for tests (rule 7c). Owns every
 * loading/error/zero-lead/eligible-picker render branch from the design
 * doc's interaction-state matrix; the mutation itself stays in the shell.
 */
export function TeamMemberRemovalDialogBody({
  preview,
  staleNotice,
  pending,
  onSubmit,
  replacementFieldError,
}: {
  preview: ReturnType<typeof useRemovalPreview>;
  staleNotice: boolean;
  pending: boolean;
  onSubmit: (values: RemovalFormValues) => void;
  /** SELF_REPLACEMENT/TARGET_NOT_TEAM_MEMBER/TARGET_ROLE_INELIGIBLE from the
   * last submit attempt (design doc: "inline field error"), or null. */
  replacementFieldError?: string | null;
}) {
  const form = useForm<RemovalFormValues>({
    resolver: zodResolver(removalSchema),
    defaultValues: { replacementUserId: NO_REPLACEMENT, reason: '' },
    mode: 'onSubmit',
  });
  const reasonLength = (useWatch({ control: form.control, name: 'reason' }) ?? '').length;

  // STALE_PREVIEW recovery: clear the chosen replacement ONLY if it's no
  // longer in the refreshed eligible list; the reason field is untouched
  // (design doc: "preserve the reason"). Runs whenever the preview data
  // object identity changes (a refetch after a stale-token retry).
  useEffect(() => {
    if (!staleNotice || preview.data === undefined) return;
    const stillEligible = preview.data.eligibleReplacements.some(
      (c) => c.userId === form.getValues('replacementUserId'),
    );
    if (!stillEligible) {
      form.setValue('replacementUserId', NO_REPLACEMENT);
    }
    // Only re-run when the preview DATA identity changes (a refetch after
    // a stale-token retry) - intentionally excludes `form` from deps since
    // react-hook-form's `form` object identity is stable across renders.
  }, [preview.data, form]);

  if (preview.isLoading) {
    return (
      <div className="space-y-2" aria-hidden="true" data-qa="team-member-removal-loading">
        <div className="bg-muted h-4 w-3/4 animate-pulse rounded" />
        <div className="bg-muted h-4 w-1/2 animate-pulse rounded" />
        <div className="bg-muted h-24 w-full animate-pulse rounded" />
      </div>
    );
  }

  if (preview.error !== null && preview.error !== undefined) {
    return <RemovalPreviewError error={preview.error} onRetry={() => void preview.refetch()} />;
  }

  const data = preview.data;
  if (data === undefined) return null;

  const affectedSummary =
    data.totalAffectedLeads === 0
      ? 'No leads are affected by this removal.'
      : `Affected: ${data.ownedCount} owned lead${data.ownedCount === 1 ? '' : 's'}` +
        (data.coOwnedCount > 0
          ? ` + ${data.coOwnedCount} co-owned lead${data.coOwnedCount === 1 ? '' : 's'}`
          : '') +
        (data.projects.length > 0
          ? ` across ${data.projects.length} project${data.projects.length === 1 ? '' : 's'}`
          : '');

  const replacementOptions = data.eligibleReplacements.map((c) => ({
    value: c.userId,
    label: `${c.name}${c.isTeamManager ? ' · Manager' : ''} (${c.role})`,
  }));

  const fields: FormFieldItemType<RemovalFormValues>[] = [];
  if (data.totalAffectedLeads > 0) {
    fields.push({
      type: 'custom',
      name: 'replacementUserId',
      label: 'Replacement',
      required: true,
      render: ({ field }) => (
        <div className="space-y-1">
          <Combobox
            value={(field.value as string | undefined) ?? NO_REPLACEMENT}
            onValueChange={(v) => field.onChange(v ?? NO_REPLACEMENT)}
            options={replacementOptions}
            placeholder="Search eligible team members..."
            emptyOptionMessage="No eligible replacement."
            selectOptionAsValue
            className="w-full"
            aria-invalid={replacementFieldError !== null && replacementFieldError !== undefined}
            data-qa="team-member-removal-replacement"
          />
          {/* SELF_REPLACEMENT/TARGET_NOT_TEAM_MEMBER/TARGET_ROLE_INELIGIBLE
              render inline on this field, not a toast (design doc). */}
          {replacementFieldError ? (
            <p
              role="alert"
              className="text-destructive text-xs"
              data-qa="form-error-message-replacementUserId"
            >
              {replacementFieldError}
            </p>
          ) : null}
        </div>
      ),
    });
  }
  fields.push({
    type: 'textarea',
    name: 'reason',
    label: 'Reason',
    required: true,
    placeholder: 'e.g. leaving the sales team for a role change',
    textareaProps: {
      rows: 2,
      maxLength: 500,
      'data-qa': 'team-member-removal-reason',
    },
    description: 'Required - recorded in the audit trail. Permanent once submitted.',
  });

  return (
    <div className="space-y-4">
      <p
        id="team-member-removal-summary"
        role="status"
        aria-live="polite"
        className="text-sm"
        data-qa="team-member-removal-summary"
      >
        {staleNotice ? 'Details changed — checking again. ' : ''}
        {affectedSummary}
      </p>
      {data.projects.length > 0 ? (
        <ul className="space-y-1">
          {data.projects.map((p) => (
            <li key={p.projectId} className="flex items-center justify-between text-sm">
              <span>{p.projectName}</span>
              <TypographyMuted>
                {p.ownedCount} owned · {p.coOwnedCount} co-owned
              </TypographyMuted>
            </li>
          ))}
        </ul>
      ) : null}
      <Form<RemovalFormValues>
        id={FORM_ID}
        form={form}
        onSubmit={onSubmit}
        hideSubmitButton
        hideResetButton
        fields={fields}
      />
      {/* Responsive/a11y contract (design doc UI5): "Reason supports 500
          characters with a visible character count." */}
      <p className="text-muted-foreground -mt-2 text-right text-xs" data-qa="team-member-removal-reason-count">
        {reasonLength}/500
      </p>
      {pending ? (
        <TypographyMuted className="text-xs">
          Transferring leads and removing the membership - this cannot be undone.
        </TypographyMuted>
      ) : null}
    </div>
  );
}

/** Typed error recovery for the preview fetch's coded 404s (design doc). */
function RemovalPreviewError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.code === 'LAST_TEAM_PARTICIPANT') {
    return (
      <div role="alert" className="space-y-2 text-sm" data-qa="team-member-removal-last-participant">
        <TypographyP>Add another team member before removing this person.</TypographyP>
      </div>
    );
  }
  if (error instanceof ApiError && error.code === 'NO_ELIGIBLE_REPLACEMENT') {
    return (
      <div role="alert" className="space-y-2 text-sm" data-qa="team-member-removal-no-eligible">
        <TypographyP>
          No same-team member can own every state among this person&apos;s leads. Reassign the
          incompatible leads through the Leads page first.
        </TypographyP>
      </div>
    );
  }
  if (error instanceof ApiError && error.code === 'TOO_MANY_AFFECTED_LEADS') {
    return (
      <div role="alert" className="space-y-2 text-sm" data-qa="team-member-removal-too-many">
        <TypographyP>{error.message}</TypographyP>
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-4 text-sm"
      data-qa="team-member-removal-error"
    >
      <TypographyP>Couldn&apos;t load this removal preview.</TypographyP>
      <TypographyMuted>{error instanceof Error ? error.message : 'Unexpected error.'}</TypographyMuted>
      <Button variant="outline" size="sm" onClick={onRetry} data-qa="team-member-removal-retry">
        Try again
      </Button>
    </div>
  );
}
