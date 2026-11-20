'use client';

// InviteStaffDialog - create an invite, then show the one-time link.
//
// A NEW FILE, deliberately: `CreateUserForm` / `CreateUserDialog` are the
// admin's existing temp-password path and are NOT modified by this feature. The
// two live side by side on the Users page ("Add user" and "Invite staff") and
// share only the role list (`creatableRolesFor`) and the team picker shape, so
// they can never disagree about who may be created.
//
// TWO STEPS, ONE DIALOG:
//   step 'form'   - email, name, phone (REQUIRED - it is what wa.me addresses),
//                   role, team.
//   step 'result' - the link, shown ONCE. The raw token exists only in this
//                   response; closing the dialog loses it and the only
//                   recovery is Resend (which rotates the token).
//
// MOBILE. `max-h-[calc(100dvh-4rem)] overflow-y-auto` is the same cap
// CreateUserDialog uses, and `100dvh` (not `100vh`) is what accounts for mobile
// browser chrome. Without it the result step's link block pushes the footer
// below the fold on a landscape phone and the dialog looks like it has no way
// out - a failure already documented on the Create dialog.
import { Button, Combobox, Dialog, Form, toast } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { LuUserPlus } from '@paalstack/react-icons/lu';
import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { CreateInviteResult } from '@shadhil/api-types';
import { useCreateInvite } from '@/hooks/queries/invites';
import type { Role } from '@/apis/client';
import { PhoneNumberInput } from '@/components/shared/PhoneNumberInput';
import { labelFor } from '@/lib/labels';
import { OptionalPhoneInputSchema } from '@/lib/phone';

import { CopyableLink } from './CopyableLink';
import { InviteSendActions } from './InviteSendActions';

/** Roles that cannot exist without a team, mirroring the backend rule. */
const ROLES_REQUIRING_TEAM: readonly Role[] = ['TELECALLER', 'SALES_EXEC', 'ENGINEER'];

/**
 * Form schema.
 *
 * PHONE IS REQUIRED HERE, unlike the Add-user form. It is the number the link
 * is sent to and what `wa.me` addresses, so an invite without one has no
 * one-tap delivery. Validated without the transform (`OptionalPhoneInputSchema`
 * pattern) so the value the user is typing is not rewritten mid-keystroke; the
 * server's `PhoneSchema` normalizes on submit.
 */
const InviteStaffFormSchema = z
  .object({
    email: z
      .email({ error: 'Enter a valid email address' })
      .trim()
      .toLowerCase()
      .min(1, 'Email is required')
      .max(254, 'Email is too long'),
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(120, 'Name must be at most 120 characters'),
    phone: OptionalPhoneInputSchema,
    role: z.string().min(1, 'Select a role'),
    teamId: z.string().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.phone === undefined || values.phone.trim().length === 0) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Phone number is required' });
    }
    if (ROLES_REQUIRING_TEAM.includes(values.role as Role) && !values.teamId) {
      ctx.addIssue({ code: 'custom', path: ['teamId'], message: 'Select a team for this user' });
    }
  });

type InviteStaffFormValues = z.infer<typeof InviteStaffFormSchema>;

function useFormId(prefix: string): string {
  return `${prefix}-${useId().replace(/:/g, '')}`;
}

/**
 * Outer shell: renders ONLY the trigger button while closed.
 *
 * The hook-bearing body is mounted on open, deliberately. The Users page renders
 * this dialog unconditionally (it IS the header action), and the page's own
 * test renders the page with no QueryClientProvider - calling `useCreateInvite`
 * at page-render time would throw `No QueryClient set` there. Lazy-mounting
 * keeps that constraint satisfied without weakening the test, and it also means
 * a closed dialog costs nothing.
 */
export function InviteStaffDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatableRoles: string[];
  showTeamField: boolean;
  teams: { id: string; name: string }[];
  teamsLoading: boolean;
}) {
  if (!props.open) {
    return (
      <Button
        leftIcon={<LuUserPlus className="h-4 w-4" />}
        onClick={() => props.onOpenChange(true)}
        data-qa="invite-staff-button"
        variant="outline"
      >
        Invite staff
      </Button>
    );
  }
  return <InviteStaffDialogBody {...props} />;
}

function InviteStaffDialogBody({
  open,
  onOpenChange,
  creatableRoles,
  showTeamField,
  teams,
  teamsLoading,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  creatableRoles: string[];
  showTeamField: boolean;
  teams: { id: string; name: string }[];
  teamsLoading: boolean;
}) {
  const formId = useFormId('invite-staff-form');
  const createInvite = useCreateInvite();
  const [result, setResult] = useState<CreateInviteResult | null>(null);
  const copyRef = useRef<HTMLDivElement>(null);

  const form = useForm<InviteStaffFormValues>({
    resolver: zodResolver(InviteStaffFormSchema) as never,
    defaultValues: {
      email: '',
      name: '',
      phone: '',
      role: (creatableRoles[0] as Role | undefined) ?? 'TELECALLER',
    },
    // onTouched matches CreateUserForm, so a mistyped number is flagged while
    // the user is still in the field rather than after a failed submit.
    mode: 'onTouched',
  });

  const selectedRole = form.watch('role');

  // Reset when the dialog CLOSES so reopening never shows a stale link or a
  // stale form - and, importantly, so the one-time link leaves the DOM.
  useEffect(() => {
    if (!open) {
      setResult(null);
      form.reset({
        email: '',
        name: '',
        phone: '',
        role: (creatableRoles[0] as Role | undefined) ?? 'TELECALLER',
      });
    }
  }, [open, form, creatableRoles]);

  // Move focus to the result panel after create: the admin's next action is
  // there, and leaving focus on the unmounted submit button strands a keyboard
  // user at the top of the page.
  useEffect(() => {
    if (result !== null) copyRef.current?.focus();
  }, [result]);

  function onSubmit(values: InviteStaffFormValues) {
    createInvite.mutate(
      {
        email: values.email,
        name: values.name,
        phone: values.phone as string,
        role: values.role as Role,
        ...(values.teamId !== undefined && values.teamId.length > 0
          ? { teamId: values.teamId }
          : {}),
      },
      {
        onSuccess: (data) => setResult(data),
        onError: (error) => {
          // Inline-safe message: the server's coded 409s (already pending /
          // email taken) are the common case and their text is actionable.
          toast.error(error instanceof Error ? error.message : 'Could not create the invite');
        },
      },
    );
  }

  const fields: FormFieldItemType<InviteStaffFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Name',
      required: true,
      placeholder: 'Enter name',
      inputProps: { autoComplete: 'name', 'data-qa': 'invite-name' },
    },
    {
      type: 'input',
      name: 'email',
      label: 'Email',
      required: true,
      inputType: 'email',
      placeholder: 'name@shadhilbuilders.in',
      inputProps: { autoComplete: 'email', 'data-qa': 'invite-email' },
    },
    {
      type: 'custom',
      name: 'phone',
      label: 'Phone',
      required: true,
      description: 'The invite link is sent to this number on WhatsApp.',
      render: ({ field }) => (
        <PhoneNumberInput {...field} placeholder="9876543210" data-qa="invite-phone" />
      ),
    },
    {
      type: 'select',
      name: 'role',
      label: 'Role',
      required: true,
      options: creatableRoles.map((value) => ({ value, label: labelFor('role', value) })),
      selectProps: { 'data-qa': 'invite-role' },
    },
  ];

  if (showTeamField && ROLES_REQUIRING_TEAM.includes(selectedRole as Role)) {
    fields.push({
      type: 'custom',
      name: 'teamId',
      label: 'Team',
      required: true,
      render: ({ field, fieldState }) => (
        <Combobox
          {...field}
          value={field.value ?? ''}
          options={teams.map((team) => ({ value: team.id, label: team.name }))}
          placeholder={teamsLoading ? 'Loading teams...' : 'Search and select a team...'}
          data-qa="invite-team"
          isInvalid={fieldState.invalid}
          onValueChange={(value) => field.onChange(value ?? undefined)}
        />
      ),
    });
  }

  const isResult = result !== null;

  return (
    <Dialog
      // The trigger is rendered by the outer shell, so this body opens with
      // `open` already true and carries no trigger of its own.
      trigger={null}
      header={{
        title: isResult ? 'Invite ready to send' : 'Invite a staff member',
        description: isResult
          ? 'Send the link now - it is shown only once.'
          : 'They will set their own name, phone and password.',
      }}
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="max-h-[calc(100dvh-4rem)] overflow-y-auto sm:max-w-lg"
      footer={
        isResult ? (
          <div className="flex w-full justify-end">
            <Button onClick={() => onOpenChange(false)} data-qa="invite-done">
              Done
            </Button>
          </div>
        ) : (
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              isLoading={createInvite.isPending}
              loadingText="Creating..."
              data-qa="invite-submit"
            >
              Create invite
            </Button>
          </div>
        )
      }
    >
      {isResult ? (
        // tabIndex={-1} makes this a programmatic focus target, not a
        // tab stop: after the async step change the admin's next action is
        // here, and leaving focus on the unmounted submit button would strand
        // a keyboard user at the top of the page.
        <div ref={copyRef} tabIndex={-1} className="space-y-4 outline-none">
          <CopyableLink value={result.inviteUrl} testId="invite-link" />
          <InviteSendActions
            whatsappUrl={result.whatsappUrl}
            phone={result.invite.phone}
            inviteeName={result.invite.name}
            testId="invite-send"
          />
          <p className="text-muted-foreground text-xs">
            This link expires in 7 days. If it is lost, use Resend on the Invites tab - that
            issues a new link and the old one stops working.
          </p>
        </div>
      ) : (
        <Form form={form} id={formId} onSubmit={onSubmit} hideSubmitButton hideResetButton fields={fields} />
      )}
    </Dialog>
  );
}
