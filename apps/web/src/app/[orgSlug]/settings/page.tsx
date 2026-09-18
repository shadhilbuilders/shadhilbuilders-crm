'use client';

// Settings - organization-scoped, available to EVERY authenticated role
// (2026-09-18). Route: `/[orgSlug]/settings`.
//
// WHY THIS PAGE EXISTS AT ALL: both user menus have always linked to
// `/settings` (`components/sidebar/nav-user.tsx`, `components/app-header.tsx`)
// and no such route existed, so "Settings" was a 404. It is also the only
// surface where a user can edit their own profile - `PATCH /api/users/:id` is
// the admin route and explicitly refuses self-edits.
//
// DELIBERATELY OUTSIDE /admin: this page is for all five roles. The admin
// namespace gate (`admin/layout.tsx`) would lock out telecallers and execs.
//
// WHAT IS *NOT* HERE, AND WHY (owner rulings 2026-09-18):
//   - Org rename: the Organization table is FORCE RLS with SELECT/INSERT/CRON
//     policies only. There is NO update policy, so a rename would be a silent
//     0-row write. The org section is read-only and says so.
//   - Email editing: this deployment configures no email verification, so a
//     self-edit could move a login to an address nobody has proven they own.
//     Email is displayed read-only and the reason is stated in the UI.
//   - Quiet hours + per-trigger notification toggles: DESIGN.md §12 lists
//     quiet hours as per-user config, but there are no columns and no
//     enforcement anywhere in the backend, and Decision #26 locks per-trigger
//     settings to v1.1. A control that changed nothing would be exactly the
//     fake UI the honest-state contract forbids, so the section explains the
//     real behaviour instead of offering a dead switch.
//
// SECTIONS: Profile (name), Password (existing endpoint), Notifications (this
// device's real push state), Organization (read-only identity), Appearance
// (the same next-themes toggle as the topbar).
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Form,
  Input,
  Label,
  Separator,
  Switch,
  useNextTheme,
  toast,
  type FormFieldItemType,
} from '@paalstack/react-ui';
import { LuArrowRight, LuExternalLink, LuInfo, LuMoon, LuSun } from '@paalstack/react-icons/lu';

import { ChangePasswordFormSchema, type ChangePasswordFormValues } from '@shadhil/api-types';

import { api } from '@/apis/client';
import { pickDefaultProject, useProjects } from '@/hooks/queries';
import { useUpdateProfile } from '@/hooks/queries/users';
import { usePushSubscription } from '@/hooks/use-push-subscription';
import { useSessionUser } from '@/lib/session';
import { useOrg, useOrgSlug } from '@/lib/tenant-context';
import { orgHref, projectHref } from '@/lib/nav';
import { labelFor } from '@/lib/labels';

import { PasswordInput } from '@/components/shared/PasswordInput';
import { PageHeader } from '@/components/shared/PageHeader';
import { Skeleton } from '@/components/shared/Skeleton';

// ---------------------------------------------------------------------------
// Profile (name) - the client-side contract, derived from the SAME rule the
// server enforces. Mirrors `nameSchema` in @shadhil/api-types (trim, 1..120):
// the server DTO is the wire contract, and this schema exists so the user gets
// an inline message instead of a 400 round-trip.
// ---------------------------------------------------------------------------
const ProfileFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(120, 'Name must be at most 120 characters'),
});
type ProfileFormValues = z.infer<typeof ProfileFormSchema>;

export default function SettingsPage() {
  const orgSlug = useOrgSlug();
  const org = useOrg();
  const { user, isPending: sessionPending, refetchSession } = useSessionUser();
  const passwordForm = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(ChangePasswordFormSchema),
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
    mode: 'onSubmit',
  });
  const [mounted, setMounted] = useState(false);

  // better-auth's useSession resolves from the cookie synchronously on the
  // client but reports isPending during SSR. Without this gate the server HTML
  // and the first client paint disagree -> hydration mismatch (the same reason
  // app-header.tsx and change-password/page.tsx gate on `mounted`).
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || sessionPending) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" breadcrumb={[{ label: 'Settings' }]} />
        <Skeleton variant="overview" className="py-4" />
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" breadcrumb={[{ label: 'Settings' }]} />
        <Card>
          <CardHeader>
            <CardTitle>Session expired</CardTitle>
            <CardDescription>
              <Link href="/login" className="underline">
                Sign in again
              </Link>{' '}
              to open your settings.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-qa="settings-page">
      <PageHeader
        title="Settings"
        breadcrumb={[{ label: 'Settings' }]}
        subtitle="Your profile, password, notifications and organization."
      />

      <ProfileSection
        userId={user.id}
        email={user.email}
        initialName={user.name}
        onSaved={async () => {
          // The sidebar and topbar render the display name from the better-auth
          // SESSION, not from the profile row - so the session must be re-read
          // or the shell keeps showing the old name until the next hard load.
          await refetchSession();
        }}
      />

      <PasswordSection form={passwordForm} userId={user.id} />

      <NotificationsSection />

      <OrganizationSection orgName={org?.name ?? null} orgSlug={orgSlug} />

      <AppearanceSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function ProfileSection({
  userId,
  email,
  initialName,
  onSaved,
}: {
  userId: string;
  email: string;
  initialName: string;
  onSaved: () => Promise<void>;
}) {
  const orgSlug = useOrgSlug();
  const updateProfile = useUpdateProfile();
  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(ProfileFormSchema),
    defaultValues: { name: initialName },
    mode: 'onSubmit',
  });

  // The session's name arrives after the first render on a cold load, so keep
  // the field in step with it until the user starts typing. `reset` only when
  // the incoming value actually differs, so a re-render never clobbers edits.
  useEffect(() => {
    if (initialName !== form.getValues('name') && !form.formState.isDirty) {
      form.reset({ name: initialName });
    }
  }, [initialName, form]);

  function onSubmit(values: ProfileFormValues): void {
    updateProfile.mutate(
      { name: values.name },
      {
        onSuccess: async (saved) => {
          toast.success('Profile updated');
          form.reset({ name: saved.name });
          await onSaved();
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : 'Could not save your profile');
        },
      },
    );
  }

  const fields: FormFieldItemType<ProfileFormValues>[] = [
    {
      type: 'input',
      name: 'name',
      label: 'Full name',
      required: true,
      placeholder: 'Your name',
      inputProps: {
        maxLength: 120,
        autoComplete: 'name',
        'data-qa': 'settings-profile-name',
      },
    },
  ];

  return (
    <Card data-qa="settings-profile">
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>
          How your name appears to teammates in the sidebar, chat mentions and
          notifications. Your email address is managed by an administrator.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 mt-4">
        <Form
          form={form}
          onSubmit={onSubmit}
          fields={fields}
          submitText={updateProfile.isPending ? 'Saving...' : 'Save name'}
          submitButtonProps={{
            type: 'submit',
            disabled: updateProfile.isPending,
            'data-qa': 'settings-profile-save',
          }}
          // Single-field form: a reset button would only discard an edit.
          hideResetButton
        />

        <Separator />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="settings-profile-email">Email</Label>
            <Input
              id="settings-profile-email"
              value={email}
              readOnly
              aria-describedby="settings-profile-email-help"
              className="min-h-11"
              data-qa="settings-profile-email"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-profile-userid">User ID</Label>
            <Input
              id="settings-profile-userid"
              value={userId}
              readOnly
              className="min-h-11 font-mono text-xs"
              data-qa="settings-profile-userid"
            />
          </div>
        </div>
        <p
          id="settings-profile-email-help"
          className="text-muted-foreground flex items-start gap-1.5 text-xs"
        >
          <LuInfo className="size-3.5 shrink-0" aria-hidden />
          <span>
            Email changes need an administrator because this deployment has no
            email-verification step - a self-service change could move your login
            to an address nobody has proven they own.
            {orgSlug !== null ? (
              <>
              {' '}
                <Link
                  href={orgHref(orgSlug, '/admin/users')}
                  className="underline inline-flex items-center gap-1"
                >
                  Admin <LuArrowRight className="size-3.5" aria-hidden /> Users
                </Link>
              </>
            ) : null}
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Password - reuses the existing self-service endpoint. The form contract and
// the server rules are the same schemas the /change-password page uses, so the
// two surfaces cannot drift.
// ---------------------------------------------------------------------------

function PasswordSection({
  form,
  userId,
}: {
  form: ReturnType<typeof useForm<ChangePasswordFormValues>>;
  userId: string;
}) {
  const [pending, setPending] = useState(false);

  function onSubmit(values: ChangePasswordFormValues): void {
    setPending(true);
    void api<{ ok: true; mustChangePassword: false }>(`/users/${userId}/change-password`, {
      method: 'POST',
      json: { oldPassword: values.oldPassword, newPassword: values.newPassword },
    }).then(
      () => {
        setPending(false);
        form.reset();
        toast.success('Password changed');
      },
      (err: unknown) => {
        setPending(false);
        toast.error(err instanceof Error ? err.message : 'Password change failed');
      },
    );
  }

  return (
    <Card data-qa="settings-password">
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>
          Change the password you sign in with. You will stay signed in on this
          device.
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-4">
        <Form
          form={form}
          onSubmit={onSubmit}
          submitText={pending ? 'Changing...' : 'Change password'}
          submitButtonProps={{
            type: 'submit',
            disabled: pending,
            'data-qa': 'settings-password-save',
          }}
          resetText="Clear"
          resetButtonProps={{ onClick: () => form.reset() }}
          fields={[
            {
              type: 'custom',
              name: 'oldPassword',
              label: 'Current password',
              required: true,
              render: ({ field }) => (
                <PasswordInput
                  {...field}
                  autoComplete="current-password"
                  maxLength={200}
                  placeholder="Current password"
                  className="min-h-11 w-full text-sm"
                  data-qa="settings-password-old"
                />
              ),
            },
            {
              type: 'custom',
              name: 'newPassword',
              label: 'New password',
              required: true,
              render: ({ field }) => (
                <PasswordInput
                  {...field}
                  autoComplete="new-password"
                  placeholder="At least 8 characters"
                  maxLength={200}
                  className="min-h-11 w-full text-sm"
                  data-qa="settings-password-new"
                />
              ),
            },
            {
              type: 'custom',
              name: 'confirmPassword',
              label: 'Confirm new password',
              required: true,
              render: ({ field }) => (
                <PasswordInput
                  {...field}
                  autoComplete="new-password"
                  maxLength={200}
                  placeholder="Confirm new password"
                  className="min-h-11 w-full text-sm"
                  data-qa="settings-password-confirm"
                />
              ),
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Notifications - reports THIS DEVICE's real push state from the same hook the
// shell's enable-prompt uses. No per-trigger switches: they are v1.1 by
// Decision #26, and the backend has no column for them, so a toggle here would
// change nothing.
// ---------------------------------------------------------------------------

function NotificationsSection() {
  const orgSlug = useOrgSlug();
  const { data: projects } = useProjects();
  const push = usePushSubscription();
  const [pending, setPending] = useState(false);
  // The inbox is a PROJECT surface (`/[orgSlug]/projects/[projectSlug]/...`), so
  // the link needs a real project slug. Use the same default-project rule the
  // rest of the app uses; with no projects the button is withheld rather than
  // pointed at a URL that would 404.
  const defaultProjectSlug = pickDefaultProject(projects ?? [])?.slug ?? null;

  const state = (() => {
    if (!push.checked) return { tone: 'muted' as const, label: 'Checking...' };
    if (!push.isSupported) return { tone: 'muted' as const, label: 'Not supported here' };
    if (push.isSubscribed) return { tone: 'ok' as const, label: 'Enabled on this device' };
    if (push.permission === 'denied')
      return { tone: 'warn' as const, label: 'Blocked in this browser' };
    return { tone: 'muted' as const, label: 'Not enabled on this device' };
  })();

  async function enable(): Promise<void> {
    setPending(true);
    const ok = await push.enablePush();
    setPending(false);
    if (ok) toast.success('Push notifications enabled');
    else if (push.permission === 'denied') {
      toast.error(
        'This browser has blocked notifications. Allow them in the site settings (padlock icon in the address bar), then try again.',
      );
    } else {
      toast.error('Notifications were not enabled');
    }
  }

  // Whether the Enable button can achieve anything.
  //
  // `permission === 'denied'` is excluded deliberately: the badge in that state
  // reads "Blocked in this browser", and offering a button next to it would
  // both contradict the message and promise something the browser will not
  // honour (a denied permission can never be re-prompted from the page - the
  // user must change it in the browser's site settings). Caught by the page
  // test, which asserted the button is withheld in that state.
  const canOfferEnable =
    push.checked && push.isSupported && !push.isSubscribed && push.permission !== 'denied';

  return (
    <Card data-qa="settings-notifications">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Push alerts for this browser, and where to find everything that was
          sent to you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 mt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Push on this device</p>
            <p className="text-muted-foreground text-xs">
              {push.checked && push.permission === 'denied'
                ? 'Blocked at the browser level - enable it in your browser site settings first.'
                : push.checked && !push.isSupported
                  ? 'This browser cannot receive push notifications (no service worker or push support).'
                  : 'Alerts are delivered per device - enable them on each browser you use.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge
              variant={state.tone === 'ok' ? 'default' : 'secondary'}
              data-qa="settings-push-state"
              data-push-state={
                !push.checked
                  ? 'checking'
                  : !push.isSupported
                    ? 'unsupported'
                    : push.isSubscribed
                      ? 'subscribed'
                      : push.permission === 'denied'
                        ? 'denied'
                        : 'available'
              }
            >
              {state.label}
            </Badge>
            {canOfferEnable ? (
              <Button
                type="button"
                size="sm"
                onClick={() => void enable()}
                disabled={pending}
                data-qa="settings-push-enable"
              >
                {pending ? 'Enabling...' : 'Enable'}
              </Button>
            ) : null}
          </div>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Notification inbox</p>
            <p className="text-muted-foreground text-xs">
              Every alert your account received, with unread counts.
            </p>
          </div>
          {defaultProjectSlug !== null ? (
            <Button
              as={Link}
              variant="outline"
              size="sm"
              href={projectHref(orgSlug, defaultProjectSlug, '/notifications')}
              data-qa="settings-notifications-link"
              rightIcon={<LuExternalLink className="size-3.5" aria-hidden />}
            >
              Open inbox
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">
              {orgSlug === null || projects === undefined
                ? 'Loading...'
                : 'Available once a project exists.'}
            </p>
          )}
        </div>

        <Separator />

        <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <LuInfo className="size-3.5 shrink-0" aria-hidden />
          <span>
            Per-alert switches (quiet hours, one toggle per event type) are not
            available yet. Today every alert is sent and you control the noise
            with the inbox's mark-as-read and dismiss actions.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Organization - READ-ONLY by owner ruling. The Organization row has no RLS
// UPDATE policy, so an edit here could not be enforced by the database; the
// section states the identity and the reason instead of faking a form.
// ---------------------------------------------------------------------------

function OrganizationSection({
  orgName,
  orgSlug,
}: {
  orgName: string | null;
  orgSlug: string | null;
}) {
  const { user } = useSessionUser();

  return (
    <Card data-qa="settings-organization">
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>
          The workspace your account belongs to. Every lead, project and team you
          see is scoped to it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 mt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="settings-org-name">Name</Label>
            <Input
              id="settings-org-name"
              value={orgName ?? '—'}
              readOnly
              className="min-h-11"
              data-qa="settings-org-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-org-slug">Workspace URL</Label>
            <Input
              id="settings-org-slug"
              value={orgSlug !== null ? `/${orgSlug}` : '—'}
              readOnly
              className="min-h-11 font-mono text-xs"
              data-qa="settings-org-slug"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="settings-role">Your role</Label>
            <Input
              id="settings-role"
              value={user !== null ? labelFor('role', user.role) : '—'}
              readOnly
              className="min-h-11"
              data-qa="settings-role"
            />
          </div>
        </div>
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
          <LuInfo className="size-3.5 shrink-0" aria-hidden />
          <span>
            Org name and workspace URL are fixed at signup and cannot be edited
            yet. Roles and access are managed by an owner or admin under <span className="inline-flex items-center gap-1"> Admin <LuArrowRight className="size-3" aria-hidden /> Users</span>.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Appearance - the same next-themes setting the topbar toggle drives, surfaced
// here so it is discoverable without hunting for the icon.
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const { resolvedTheme, setTheme } = useNextTheme();
  const { user } = useSessionUser();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <Card data-qa="settings-appearance">
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Theme for this browser. Stored locally, so it follows this device only.
        </CardDescription>
      </CardHeader>
      <CardContent className='mt-4'>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {isDark ? (
              <LuMoon className="size-4" aria-hidden />
            ) : (
              <LuSun className="size-4" aria-hidden />
            )}
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Dark mode</p>
              <p className="text-muted-foreground text-xs">
                {mounted ? (isDark ? 'On' : 'Off') : 'Loading...'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="settings-dark-mode"
              checked={isDark}
              onCheckedChange={(checked) => setTheme(checked ? 'dark' : 'light')}
              disabled={!mounted}
              aria-label="Dark mode"
              data-qa="settings-dark-mode"
            />
            <Label htmlFor="settings-dark-mode">Dark mode</Label>
          </div>
        </div>
        {user !== null ? (
          <p className="text-muted-foreground mt-4 text-xs">
            Signed in as {user.email}.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
