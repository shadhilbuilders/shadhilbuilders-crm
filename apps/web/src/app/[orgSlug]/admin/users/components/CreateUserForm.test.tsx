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
}));

vi.mock('@/hooks/queries/users', () => ({
  // useCreateUser is invoked by the dialog wrapper; the form touches only
  // the mutation object's isPending flag, so a static shape suffices.
  useCreateUser: () => ({ mutate: mocks.mutate, isPending: false }),
}));

// Imported AFTER the mock so the form binds the mocked hook.
import { CreateUserForm } from './CreateUserForm';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <CreateUserForm
        creatableRoles={['ADMIN', 'MANAGER', 'TELECALLER', 'SALES_EXEC', 'ENGINEER']}
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
  const form = container?.querySelector('form#create-user-form');
  if (!form) throw new Error('form#create-user-form not rendered');
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

afterEach(async () => {
  await unmount();
  mocks.mutate.mockReset();
});

describe('CreateUserForm silent-submit regression', () => {
  it('invalid submit renders the error alert and fires NO mutation', async () => {
    await mount();
    await act(async () => {
      submitForm();
    });
    const alert = container?.querySelector('[data-qa="create-user-errors"]');
    expect(alert).not.toBeNull();
    const text = alert?.textContent ?? '';
    expect(text).toContain('Name is required');
    expect(text).toContain('Too small: expected string to have >=3 characters');
    expect(text).toContain('Password must be at least 8 characters');
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

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
    expect(container?.querySelector('[data-qa="create-user-errors"]')?.textContent ?? '').toBe(
      '',
    );
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Priya Engineer',
        email: 'priya@example.com',
        password: 'StrongPass-2026',
        role: 'ADMIN',
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    expect(container?.querySelector('[data-qa="create-user-errors"]')).toBeNull();
  });

  it('fields regain validity: the alert clears once the inputs are fixed', async () => {
    await mount();
    await act(async () => {
      submitForm();
    });
    expect(container?.querySelector('[data-qa="create-user-errors"]')).not.toBeNull();

    setInput('name', 'Fixed Name');
    setInput('email', 'fixed@example.com');
    setInput('password', 'StrongPass-2026');
    await act(async () => {
      submitForm();
    });
    expect(container?.querySelector('[data-qa="create-user-errors"]')).toBeNull();
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });
});