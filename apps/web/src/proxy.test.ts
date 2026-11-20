import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import proxy from './proxy';

function req(path: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return new NextRequest(new URL(`https://crm.shadhilbuilders.in${path}`), { headers });
}

describe('proxy session gate', () => {
  it('redirects an authenticated /login to / (the reported bug)', () => {
    // The exact production request: only the __Secure- cookie is present.
    const res = proxy(req('/login', '__Secure-better-auth.session_token=token.sig'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('https://crm.shadhilbuilders.in/');
  });

  it('redirects an authenticated /login to / on http dev too', () => {
    const res = proxy(req('/login', 'better-auth.session_token=dev.sig'));
    expect(res.status).toBe(307);
  });

  it('lets an anonymous /login render the form', () => {
    const res = proxy(req('/login'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('bounces an anonymous protected path to /login?next=', () => {
    const res = proxy(req('/shadhil-builders/admin'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe(
      'https://crm.shadhilbuilders.in/login?next=%2Fshadhil-builders%2Fadmin',
    );
  });

  it('serves the plot-layout artwork to anonymous requests (SW precache)', () => {
    // The service worker precaches this from /login with no session; a redirect
    // there caches login HTML under the SVG URL and breaks the plot map in prod.
    const res = proxy(req('/cmda-plan.svg'));
    expect(res.headers.get('location')).toBeNull();
  });

  it('passes an authenticated protected path through', () => {
    const res = proxy(req('/shadhil-builders/admin', '__Secure-better-auth.session_token=t'));
    expect(res.headers.get('location')).toBeNull();
  });

  // ── Staff invites (2026-11-20) ────────────────────────────────────────────
  // A staff member opening an invite has NO session: the token in the path is
  // the credential. This file's own header documents four separate incidents
  // caused by a public path being missed here, and missing /invite would make
  // the whole onboarding flow unreachable - the invitee would land on
  // /login?next=/invite/... instead of their form.
  it('lets an anonymous /invite/<token> render the accept form', () => {
    const res = proxy(req('/invite/abc123TOKEN'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('lets the public invite API through without a session', () => {
    // The accept form POSTs here; a redirect would turn the submit into a
    // navigation to /login and the account would never be created.
    expect(proxy(req('/api/public/invites/abc123TOKEN')).headers.get('location')).toBeNull();
  });
});
