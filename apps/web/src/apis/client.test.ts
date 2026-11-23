// ApiError coded-envelope parsing - T-TEAM-AUTHORITATIVE (2026-09-13, UI4).
//
// The Nest backend's CodedException throws { code, message, details }
// object bodies verbatim (no wrapping - see
// apps/backend/src/common/errors/coded-exception.ts). `api()` must surface
// those fields on the thrown ApiError so callers can branch on stable
// error codes instead of parsing human message strings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, sessionUserFromSession } from './client';

function mockFetchOnce(response: { status: number; body?: unknown; ok?: boolean }): void {
  const ok = response.ok ?? (response.status >= 200 && response.status < 300);
  const bodyText = response.body !== undefined ? JSON.stringify(response.body) : '';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: response.status,
      ok,
      statusText: 'Mocked',
      text: async () => bodyText,
      json: async () => (bodyText.length > 0 ? JSON.parse(bodyText) : undefined),
    }),
  );
}

describe('api() error envelope parsing', () => {
  beforeEach(() => {
    // api() redirects to /login on 401 via window.location - not exercised
    // by these coded-4xx/409 tests, but stub location defensively.
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/test' },
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('carries the typed retryable flag, and null when the envelope has none', async () => {
    mockFetchOnce({
      status: 503,
      body: { code: 'VIDEO_SAVE_FAILED', message: 'Could not save.', retryable: true },
    });
    await expect(api('/x', { method: 'POST' })).rejects.toMatchObject({ retryable: true });
    mockFetchOnce({ status: 400, body: { code: 'VIDEO_TOO_LONG', message: 'Too long.' } });
    await expect(api('/x', { method: 'POST' })).rejects.toMatchObject({ retryable: null });
    mockFetchOnce({ status: 400, body: { message: 'x', retryable: 'yes' } });
    await expect(api('/x', { method: 'POST' })).rejects.toMatchObject({ retryable: null });
  });

  it('surfaces code + details from a CodedException envelope (409)', async () => {
    mockFetchOnce({
      status: 409,
      body: {
        code: 'PROJECT_TEAM_HAS_LEADS',
        message: '5 leads are assigned to this team on this project.',
        details: { leadCount: 5 },
      },
    });

    await expect(api('/projects/proj-1/teams/team-a', { method: 'DELETE' })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.status).toBe(409);
        expect(apiErr.code).toBe('PROJECT_TEAM_HAS_LEADS');
        expect(apiErr.details).toEqual({ leadCount: 5 });
        expect(apiErr.message).toBe('5 leads are assigned to this team on this project.');
        return true;
      },
    );
  });

  it('code is null when the backend did not emit a coded envelope', async () => {
    mockFetchOnce({
      status: 400,
      body: { message: ['name: Name is required'] },
    });

    await expect(api('/projects', { method: 'POST', json: {} })).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(ApiError);
        const apiErr = err as ApiError;
        expect(apiErr.code).toBeNull();
        expect(apiErr.message).toBe('name: Name is required');
        return true;
      },
    );
  });

  it('code and details are null/undefined for a non-JSON error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 500,
        ok: false,
        statusText: 'Internal Server Error',
        text: async () => 'plain text failure',
        json: async () => {
          throw new Error('not json');
        },
      }),
    );

    await expect(api('/projects')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(500);
      expect(apiErr.code).toBeNull();
      expect(apiErr.message).toContain('plain text failure');
      return true;
    });
  });

  it('returns the parsed JSON body on success', async () => {
    mockFetchOnce({ status: 200, body: { ok: true } });
    const result = await api<{ ok: boolean }>('/projects/proj-1/teams');
    expect(result).toEqual({ ok: true });
  });

  // Issue #8 slice 2 / D3 (2026-11-10): a buyer must rotate INSIDE the portal
  // shell (masthead + Sign out, no Cancel), while staff keep the guest page.
  // The backend does not know which shell issued the request, so the path the
  // browser is on is the signal.
  it('sends a portal 403 PASSWORD_CHANGE_REQUIRED to the portal rotation screen', async () => {
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/portal' },
      writable: true,
    });
    mockFetchOnce({
      status: 403,
      body: {
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'change it',
        redirect: '/change-password',
      },
    });

    await expect(api('/customer-portal/me')).rejects.toBeInstanceOf(ApiError);
    expect(window.location.href).toBe('/portal/change-password');
  });

  it('sends a staff 403 PASSWORD_CHANGE_REQUIRED to the guest page', async () => {
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/demo/admin/users' },
      writable: true,
    });
    mockFetchOnce({
      status: 403,
      body: {
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'change it',
        redirect: '/change-password',
      },
    });

    await expect(api('/users')).rejects.toBeInstanceOf(ApiError);
    expect(window.location.href).toBe('/change-password');
  });
});

// The rotation flag rides on the session as an additionalField. It must read
// STRICTLY as boolean true: a missing/null/string value means "already
// rotated", so an older session row degrades to the 403 backstop instead of
// locking a buyer out of a portal they are entitled to.
describe('sessionUserFromSession - mustChangePassword', () => {
  const base = {
    user: { id: 'u-1', name: 'Anita', email: 'a@x.in', role: 'CUSTOMER', organizationId: 'org-1' },
  };

  it('reads a true flag', () => {
    const user = sessionUserFromSession({
      ...base,
      user: { ...base.user, mustChangePassword: true },
    });
    expect(user?.mustChangePassword).toBe(true);
  });

  it('defaults to false when the field is absent or not a boolean', () => {
    expect(sessionUserFromSession(base)?.mustChangePassword).toBe(false);
    expect(
      sessionUserFromSession({ ...base, user: { ...base.user, mustChangePassword: null } })
        ?.mustChangePassword,
    ).toBe(false);
    expect(
      sessionUserFromSession({ ...base, user: { ...base.user, mustChangePassword: 'true' } })
        ?.mustChangePassword,
    ).toBe(false);
  });
});
