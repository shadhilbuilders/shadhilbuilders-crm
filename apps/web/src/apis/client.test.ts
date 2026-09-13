// ApiError coded-envelope parsing - T-TEAM-AUTHORITATIVE (2026-09-13, UI4).
//
// The Nest backend's CodedException throws { code, message, details }
// object bodies verbatim (no wrapping - see
// apps/backend/src/common/errors/coded-exception.ts). `api()` must surface
// those fields on the thrown ApiError so callers can branch on stable
// error codes instead of parsing human message strings.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError } from './client';

function mockFetchOnce(response: {
  status: number;
  body?: unknown;
  ok?: boolean;
}): void {
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
});
