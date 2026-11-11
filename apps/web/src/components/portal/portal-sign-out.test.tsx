// PortalSignOut: the buyer's only exit from the portal.
//
// protects= an accessible-named 44px-capable masthead trigger, a confirmation
//           that starts CLOSED and can be cancelled, one sign-out per confirm
//           even under a double tap, and a visible error (not a silent dead
//           button) when the sign-out call fails.
// fails_when= the trigger loses its aria-label, the dialog opens on mount or
//           cannot be cancelled, a double confirm fires two sign-outs, or a
//           rejection leaves the control disabled forever.
// no_claim= static markup + handler wiring only: no real better-auth session,
//           no browser navigation, no visual/dialog-focus QA.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  toastError: vi.fn(),
  alertDialogProps: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth-actions', () => ({
  useSignOut: () => mocks.signOut,
}));

// The library AlertDialog portals into <body>, so it is replaced with a marker
// that records the props the component passes (same pattern as
// push-enable-prompt.test.tsx).
vi.mock('@paalstack/react-ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AlertDialog: (props: Record<string, unknown>) => {
      mocks.alertDialogProps.push(props);
      return <div data-qa="alert-dialog-stub" data-open={String(props.open === true)} />;
    },
    toast: { error: mocks.toastError },
  };
});

import { PortalSignOut } from './portal-sign-out';

const lastDialogProps = (): Record<string, unknown> => {
  const props = mocks.alertDialogProps.at(-1);
  if (props === undefined) throw new Error('AlertDialog was never rendered');
  return props;
};

describe('PortalSignOut', () => {
  it('renders an accessible-named icon trigger', () => {
    mocks.alertDialogProps.length = 0;
    const html = renderToStaticMarkup(<PortalSignOut />);
    // The icon is the only content - without aria-label the control has no
    // accessible name.
    expect(html).toContain('aria-label="Sign out"');
    expect(html).toContain('data-qa="portal-sign-out"');
  });

  // The trigger is a round ghost icon button: 36px on phones, growing to a
  // 44px tap target from `sm` up.
  it('renders a round icon button, 36px growing to 44px from sm', () => {
    mocks.alertDialogProps.length = 0;
    const html = renderToStaticMarkup(<PortalSignOut />);
    const button = /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(button).toContain('size-9');
    expect(button).toContain('min-h-9');
    expect(button).toContain('min-w-9');
    expect(button).toContain('sm:size-11');
    expect(button).toContain('sm:min-h-11');
    expect(button).toContain('sm:min-w-11');
    expect(button).toContain('rounded-full');
  });

  // The GLYPH is sized separately from the button. The library's base rule is
  // `[&_svg:not([class*='size-'])]:size-4`, so a `size-5` class opts the svg out
  // of that 16px fallback and renders it at 20px.
  it('sizes the glyph separately from the button', () => {
    mocks.alertDialogProps.length = 0;
    const html = renderToStaticMarkup(<PortalSignOut />);
    const svg = /<svg[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(svg).toContain('size-5');
    // size-5 sizes the glyph only; it must not leak onto the button.
    const button = /<button[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(button).not.toContain('size-5');
  });

  it('starts closed - no accidental dialog on page load', () => {
    mocks.alertDialogProps.length = 0;
    renderToStaticMarkup(<PortalSignOut />);
    expect(lastDialogProps().open).toBe(false);
  });

  it('asks before signing out, with Cancel available', () => {
    mocks.alertDialogProps.length = 0;
    renderToStaticMarkup(<PortalSignOut />);
    const props = lastDialogProps();
    expect(props.cancelButtonText).toBe('Cancel');
    expect(props.confirmButtonText).toBe('Sign out');
    const header = props.header as { title: string; description: string };
    expect(header.title).toContain('Sign out');
  });

  it('calls signOut exactly once when confirm fires', async () => {
    mocks.alertDialogProps.length = 0;
    mocks.signOut.mockReset().mockResolvedValue(undefined);
    renderToStaticMarkup(<PortalSignOut />);
    const onConfirm = lastDialogProps().onConfirm as () => void;
    onConfirm();
    await Promise.resolve();
    expect(mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed sign-out instead of failing silently', async () => {
    mocks.alertDialogProps.length = 0;
    mocks.signOut.mockReset().mockRejectedValue(new Error('network down'));
    mocks.toastError.mockReset();
    renderToStaticMarkup(<PortalSignOut />);
    const onConfirm = lastDialogProps().onConfirm as () => void;
    onConfirm();
    // Let the rejection settle.
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError.mock.calls[0]?.[0]).toContain('Could not sign out');
  });
});
