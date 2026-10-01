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
    const res = proxy(
      req('/login', '__Secure-better-auth.session_token=token.sig'),
    );
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

  it('passes an authenticated protected path through', () => {
    const res = proxy(
      req('/shadhil-builders/admin', '__Secure-better-auth.session_token=t'),
    );
    expect(res.headers.get('location')).toBeNull();
  });
});
