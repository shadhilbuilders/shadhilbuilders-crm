// InviteSendActions (2026-11-20).
//
// Three constraints are pinned here, each from a real failure mode:
//   1. NO auto-navigation. An unexpected app launch on a phone is jarring, and
//      on a desktop with no WhatsApp it does nothing at all.
//   2. The wa.me href comes FROM THE SERVER, never assembled here - it needs the
//      digits-only form and a stray `+` silently 404s.
//   3. WhatsApp sits BESIDE Copy, never instead of it: the iOS handoff may not
//      come back, so the link must be copyable first.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InviteSendActions } from './InviteSendActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WA_URL = 'https://wa.me/919876543210?text=Hi%20Ramesh';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('InviteSendActions', () => {
  it('renders WhatsApp and Call', () => {
    const el = mount(
      <InviteSendActions whatsappUrl={WA_URL} phone="919876543210" inviteeName="Ramesh" />,
    );
    expect(el.querySelector('[data-qa="invite-send-whatsapp"]')).not.toBeNull();
    expect(el.querySelector('[data-qa="invite-send-call"]')).not.toBeNull();
  });

  it('uses the SERVER-supplied wa.me URL verbatim', () => {
    const el = mount(
      <InviteSendActions whatsappUrl={WA_URL} phone="919876543210" inviteeName="Ramesh" />,
    );
    const link = el.querySelector<HTMLAnchorElement>('[data-qa="invite-send-whatsapp"]');
    expect(link?.getAttribute('href')).toBe(WA_URL);
    // The path segment must stay digits-only; a `+` here 404s silently.
    expect(link?.getAttribute('href')).not.toContain('+91');
  });

  it('opens in a new tab with rel=noopener noreferrer', () => {
    const el = mount(
      <InviteSendActions whatsappUrl={WA_URL} phone="919876543210" inviteeName="Ramesh" />,
    );
    const link = el.querySelector<HTMLAnchorElement>('[data-qa="invite-send-whatsapp"]');
    expect(link?.getAttribute('target')).toBe('_blank');
    // Without noopener the target page can reach window.opener.
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('DOES NOT auto-navigate on mount', () => {
    // A redirect after create would fire on a desktop with no WhatsApp too.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });

    mount(<InviteSendActions whatsappUrl={WA_URL} phone="919876543210" inviteeName="Ramesh" />);

    expect(open).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('labels the WhatsApp action with the invitee, not a bare icon', () => {
    const el = mount(
      <InviteSendActions whatsappUrl={WA_URL} phone="919876543210" inviteeName="Ramesh Kumar" />,
    );
    const link = el.querySelector('[data-qa="invite-send-whatsapp"]');
    expect(link?.getAttribute('aria-label')).toContain('Ramesh Kumar');
  });

  it('renders no emoji (icons only)', () => {
    const el = mount(
      <InviteSendActions whatsappUrl={WA_URL} phone="919876543210" inviteeName="Ramesh" />,
    );
    // Emoji render differently on every platform and read as sloppy in a
    // staff-facing product; the icon set is the repo's convention.
    expect(el.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('omits WhatsApp when no URL is available (a table row has no token)', () => {
    const el = mount(
      <InviteSendActions whatsappUrl={null} phone="919876543210" inviteeName="Ramesh" />,
    );
    expect(el.querySelector('[data-qa="invite-send-whatsapp"]')).toBeNull();
    // Call still works - the phone is on the row.
    expect(el.querySelector('[data-qa="invite-send-call"]')).not.toBeNull();
  });

  it('builds the tel: link through telUrl, not by hand', () => {
    const el = mount(
      <InviteSendActions whatsappUrl={null} phone="919876543210" inviteeName="Ramesh" />,
    );
    const call = el.querySelector<HTMLAnchorElement>('[data-qa="invite-send-call"]');
    // telUrl adds the + for the stored 91XXXXXXXXXX form; a bare href would
    // dial the country code as part of the subscriber number.
    expect(call?.getAttribute('href')).toBe('tel:+919876543210');
  });
});
