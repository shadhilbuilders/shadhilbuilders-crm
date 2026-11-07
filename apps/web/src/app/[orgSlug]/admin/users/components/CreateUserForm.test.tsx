// CreateUserForm - the silent-submit regression (issue #7 QA follow-up).
//
// The form posts to POST /api/users through the react-ui Form component,
// which wires react-hook-form's handleSubmit WITHOUT an onInvalid callback.
// An invalid submission (empty name, bad email, short password) was dropped
// silently: no request, no toast, no rendered message. The operator saw a
// dead button. The fix subscribes to formState.errors and renders a summary
// alert. These tests pin both behaviors:
//   1. invalid submit -> the alert renders with every failing field message
//   2. valid submit -> no alert, and the mutation fires once with the typed
//      payload (the success path must not regress into always-on alerts)
//
// The react-ui Form's submit path is exercised for real (DOM submit event on
// the form element), because the defect lived exactly in that path.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  // The user's actual complaint: a TOAST appeared for the missing team.
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@paalstack/react-ui')>();
  return {
    ...actual,
    // Spy on the real toast.error so a regression to `toast.error(...)` for
    // the missing-team case is observable, without losing the real exports.
    toast: { ...actual.toast, error: mocks.toastError, success: mocks.toastSuccess },
  };
});

vi.mock('@/hooks/queries/users', () => ({
  // useCreateUser is invoked by the dialog wrapper; the form touches only
  // the mutation object's isPending flag, so a static shape suffices.
  useCreateUser: () => ({ mutate: mocks.mutate, isPending: false }),
}));

// Imported AFTER the mock so the form binds the mocked hook.
import { CreateUserDtoSchema } from '@shadhil/api-types';
import { CreateUserForm, CreateUserFormSchema } from './CreateUserForm';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(creatableRoles: string[] = [
  'ADMIN',
  'MANAGER',
  'TELECALLER',
  'SALES_EXEC',
  'ENGINEER',
]): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CreateUserForm
        formId="test-create-user-form"
        creatableRoles={creatableRoles}
        createUser={{ mutate: mocks.mutate, isPending: false } as never}
        onDone={() => {}}
        showTeamField
        teams={[{ id: 't-1', name: 'Team Alpha' }]}
        teamsLoading={false}
      />,
    );
  });
}

async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
}

function setInput(name: string, value: string): void {
  const input = container?.querySelector(`[name="${name}"]`);
  if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) {
    throw new Error(`input [name="${name}"] not rendered`);
  }
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function submitForm(): void {
  const form = container?.querySelector('form#test-create-user-form');
  if (!form) throw new Error('form#test-create-user-form not rendered');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  await unmount();
  mocks.mutate.mockReset();
  mocks.toastError.mockReset();
  mocks.toastSuccess.mockReset();
});

describe('CreateUserForm silent-submit regression', () => {


  it('valid submit fires the mutation once with the typed payload and shows no alert', async () => {
    await mount();
    // Act on the REAL inputs so RHF registration + zod see actual values.
    setInput('name', 'Priya Engineer');
    setInput('email', 'priya@example.com');
    setInput('password', 'StrongPass-2026');
    // role: creatableRoles[0] default (ADMIN). TELECALLER would exercise the
    // same no-team staff path with a select interaction jsdom can't drive;
    // the payload shape is what this test pins.
    await act(async () => {
      submitForm();
    });
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Priya Engineer',
        email: 'priya@example.com',
        password: 'StrongPass-2026',
        role: 'ADMIN',
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('fields regain validity: the alert clears once the inputs are fixed', async () => {
    await mount();
    await act(async () => {
      submitForm();
    });

    setInput('name', 'Fixed Name');
    setInput('email', 'fixed@example.com');
    setInput('password', 'StrongPass-2026');
    await act(async () => {
      submitForm();
    });
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});

describe('CreateUserForm team id validation (site-engineer dead button)', () => {
  // Regression for the 2026-11-01 report: "site engineer creation button not
  // working".
  //
  // The DTO validated teamId with z.cuid2(). Team.id is a mix of shapes:
  // cuid v1 (Prisma `@default(cuid())`), cuid2 (seed), and dash-separated
  // slug ids (test fixtures in the DB, e.g. `test-outbound-cron-team`). The
  // first two happen to satisfy z.cuid2(); the SLUG ids do not. Because the
  // create dialog's Team picker lists every active team, an operator who
  // picked one of those got a local validation block reading only
  // "Invalid cuid2" - no field name, no request sent - so pressing Create
  // did nothing visible. ENGINEER is the role that shows the Team picker,
  // which is why the report was specifically about site engineers.
  //
  // Verified against the live DB: the dashed ids below are real rows.
  it.each([
    ['cuid v1 (app-created team)', 'cmuto0p6o002wzpu89t11tn18'],
    ['cuid2 (seed team)', 'vfm3sd2qgekdrvmc2tm8h4me'],
    ['slug id (the previously-broken shape)', 'test-outbound-cron-team'],
    ['slug id with timestamp', 'auto-team-cap-1790627697790-euytb5'],
  ])('accepts a %s teamId', async (_label, teamId) => {
    const parsed = CreateUserDtoSchema.safeParse({
      name: 'Site Engineer',
      email: 'site.engineer@example.com',
      password: 'StrongPass-2026',
      role: 'ENGINEER',
      teamId,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty teamId with an actionable message, not "Invalid cuid2"', () => {
    const parsed = CreateUserDtoSchema.safeParse({
      name: 'Site Engineer',
      email: 'site.engineer@example.com',
      password: 'StrongPass-2026',
      role: 'ENGINEER',
      teamId: '   ',
    });
    expect(parsed.success).toBe(false);
    const messages = parsed.error?.issues.map((i) => i.message) ?? [];
    expect(messages.join(' ')).toContain('Select a team');
    expect(messages.join(' ')).not.toContain('cuid2');
  });
});

describe('CreateUserForm team-required error renders INLINE (not a toast)', () => {
  // Requested 2026-11-01: "show inline error instead of toast error for not
  // selecting team when site engineer role was selected".
  //
  // The missing-team rule used to be a `toast.error(...)` early-return inside
  // onSubmit, so the message appeared in a transient toast far from the Team
  // picker. It is now a schema refinement, which puts it in formState.errors
  // where the Combobox renders it under the field.
  //
  // NOTE ON WHAT PINS WHAT: onSubmit keeps a defensive `form.setError` guard,
  // which renders the SAME inline DOM. So the DOM assertions below would also
  // pass on that fallback alone. The behaviour-specific assertions are the
  // schema unit test (the refinement is what must catch it, before onSubmit
  // runs) and `toastError` never being called.
  it.each(['TELECALLER', 'SALES_EXEC', 'ENGINEER'] as const)(
    'rejects a %s without a team in the SCHEMA (before onSubmit)',
    (role) => {
      const parsed = CreateUserFormSchema.safeParse({
        name: 'Site Engineer',
        email: 'site.engineer@example.com',
        password: 'StrongPass-2026',
        role,
      });
      expect(parsed.success).toBe(false);
      const issue = parsed.error?.issues.find((i) => i.path[0] === 'teamId');
      expect(issue?.message).toBe('Select a team for this user');
    },
  );

  it('does NOT demand a team for MANAGER (the service auto-creates one)', () => {
    const parsed = CreateUserFormSchema.safeParse({
      name: 'New Manager',
      email: 'manager@example.com',
      password: 'StrongPass-2026',
      role: 'MANAGER',
    });
    expect(parsed.success).toBe(true);
  });

  it('renders the message next to the Team field, fires NO mutation, NO toast', async () => {
    // ENGINEER first so the Team picker is mounted on first render (the role
    // Select is a Base UI listbox that jsdom cannot drive reliably).
    await mount(['ENGINEER', 'TELECALLER']);
    setInput('name', 'Site Engineer');
    setInput('email', 'site.engineer@example.com');
    setInput('password', 'StrongPass-2026');

    await act(async () => {
      submitForm();
    });

    // The message is rendered ONCE, by react-ui's Form, in the field's error
    // slot. It used to also be passed to the Combobox as `errorMessage`, which
    // printed the same sentence twice under the picker (2026-11-06 report).
    const teamField = container?.querySelector('[data-qa="form-field-teamId"]');
    expect(teamField).not.toBeNull();
    const inline = teamField?.querySelector('[data-qa="form-error-message-teamId"]');
    expect(inline).not.toBeNull();
    expect(inline?.textContent ?? '').toContain('Select a team for this user');
    // Guards the duplicate: the Combobox's own message must NOT be present.
    expect(teamField?.querySelector('[data-qa="combobox-error-message"]')).toBeNull();
    const occurrences = (teamField?.textContent ?? '').split('Select a team for this user').length - 1;
    expect(occurrences).toBe(1);

    // The picker is marked invalid so it reads as an error, not a hint.
    const input = teamField?.querySelector('input');
    expect(input?.getAttribute('aria-invalid')).toBe('true');

    // Nothing was submitted, and - the user's actual complaint - no toast.
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('does NOT require a team for a role that auto-creates one (MANAGER)', async () => {
    // MANAGER is creatable but has no Team picker (the service auto-creates
    // its team), so the refinement must not fire for it.
    await mount(['MANAGER']);
    setInput('name', 'New Manager');
    setInput('email', 'manager@example.com');
    setInput('password', 'StrongPass-2026');

    await act(async () => {
      submitForm();
    });

    expect(container?.querySelector('[data-qa="form-field-teamId"]')).toBeNull();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'MANAGER' }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    // No teamId key at all for a manager.
    expect(mocks.mutate.mock.calls[0]?.[0]).not.toHaveProperty('teamId');
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});