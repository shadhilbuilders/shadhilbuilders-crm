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
import { Button, Combobox, Dialog, Form, Input, Label, toast } from '@paalstack/react-ui';
import type { FormFieldItemType } from '@paalstack/react-ui';
import { zodResolver } from '@hookform/resolvers/zod';
import { LuChevronRight, LuUserPlus } from '@paalstack/react-icons/lu';
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
    /**
     * Optional since 2026-11-21. The union, not `.optional()`, is the project
     * convention for a text input that may be left blank: the field always holds
     * a string, and the server's `EmailSchema.optional()` would 400 on `''` as
     * if the address were malformed. Blank is turned into an omitted key in
     * `onSubmit`, never into `email: ''`.
     */
    email: z.union([
      z.literal(''),
      z
        .email({ error: 'Enter a valid email address' })
        .trim()
        .toLowerCase()
        .max(254, 'Email is too long'),
    ]),
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
  const emailInputId = useFormId('invite-email');
  const createInvite = useCreateInvite();
  const [result, setResult] = useState<CreateInviteResult | null>(null);
  const [emailExpanded, setEmailExpanded] = useState(false);
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
      setEmailExpanded(false);
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
        // Blank means "no email": the key is omitted so the service generates a
        // placeholder, rather than sending '' and being refused as malformed.
        ...(values.email.length > 0 ? { email: values.email } : {}),
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

  // The panel stays open while it holds a value: collapsing a typed address
  // would hide what the invite will use, and the trigger cannot show it back.
  // "Remove email" is the way back to the collapsed state.
  const emailValue = form.watch('email');
  const showEmailField = emailExpanded || emailValue.length > 0;
  const emailPanelId = `${emailInputId}-panel`;
  const emailError = form.formState.errors.email?.message;

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
      // The dialog is a grid: header / body / footer are siblings, and the
      // FOOTER carries the submit. Scrolling the whole popup (the previous
      // `overflow-y-auto` here) therefore scrolled the submit off screen on a
      // landscape phone, where a 100dvh-4rem cap is ~256px - the form alone is
      // taller than that, so the footer sat below the fold and the dialog
      // looked like it had no way to submit (caught by
      // invites-mobile-audit.spec.ts at 568x320).
      //
      // `max-h` + `grid-rows-[auto_minmax(0,1fr)_auto]` instead pins the header
      // and footer and makes the BODY the only scrolling region: the body is
      // `children` and gets `overflow-y-auto` per-step below.
      // `sm:max-w-md` is the library's standard dialog width. The three fields and
      // the footer are single-column, so the extra 8rem of `lg` bought nothing
      // but a wider tap target to miss on a phone.
      contentClassName="max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-md"
      footer={
        isResult ? (
          <div className="flex w-full justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)} data-qa="invite-close">
              Close
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
        <div ref={copyRef} tabIndex={-1} className="min-h-0 space-y-4 overflow-y-auto outline-none">
          <CopyableLink value={result.inviteUrl} testId="invite-link" />
          <InviteSendActions
            whatsappUrl={result.whatsappUrl}
            phone={result.invite.phone}
            inviteeName={result.invite.name}
            testId="invite-send"
          />
          <p className="text-muted-foreground text-xs">
            This link expires in 7 days. If it is lost, use Resend on the Invites tab - that issues
            a new link and the old one stops working.
          </p>
        </div>
      ) : (
        <div className="min-h-0 overflow-y-auto px-2">
          <Form
            form={form}
            id={formId}
            onSubmit={onSubmit}
            hideSubmitButton
            hideResetButton
            fields={fields}
          />

          {/*
            Email lives OUTSIDE the field list on purpose: it is optional, and a
            Form field would render a permanent "Email" label for something most
            invites do not fill in. The disclosure keeps the default form at
            name / phone / role and one quiet line.
          */}
          <div className="mt-4 border-t pt-3">
            {showEmailField ? (
              <div id={emailPanelId} className="space-y-2">
                <Label htmlFor={emailInputId}>Email</Label>
                <Input
                  id={emailInputId}
                  type="email"
                  autoComplete="email"
                  placeholder="name@shadhilbuilders.in"
                  data-qa="invite-email"
                  aria-invalid={emailError ? true : undefined}
                  {...form.register('email')}
                />
                <p className="text-muted-foreground text-xs">
                  Used for signing in and notifications. Leave it empty and the person signs in with
                  their phone number.
                </p>
                {emailError ? (
                  <p className="text-danger text-xs" role="alert">
                    {emailError}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0"
                  data-qa="invite-email-remove"
                  onClick={() => {
                    form.setValue('email', '');
                    form.clearErrors('email');
                    setEmailExpanded(false);
                  }}
                >
                  Remove email
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground px-0"
                onClick={() => setEmailExpanded(true)}
                aria-expanded={false}
                aria-controls={emailPanelId}
                data-qa="invite-email-toggle"
              >
                <LuChevronRight className="size-4" />
                Add an email (optional)
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
