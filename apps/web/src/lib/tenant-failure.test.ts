import { describe, expect, it } from 'vitest';

import {
  PASSWORD_CHANGE_REQUIRED,
  actionForFailure,
  classifyBackendFailure,
  type TenantFailure,
} from './tenant-failure';

// These pin the contract that broke `/shadhil-builders/settings`: a missing
// session must NOT be reported as "this page does not exist".

describe('classifyBackendFailure', () => {
  it('agrees with the backend on the rotation-gate code', () => {
    // The backend puts this exact string on its 403 (JwtAuthGuard). If the
    // two ever diverge, the rotation gate silently stops routing users to
    // /change-password and they see a 404 instead - so pin the value here.
    expect(PASSWORD_CHANGE_REQUIRED).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('treats a backend that never answered as unavailable, never as not-found', () => {
    // A connection refused must not tell the user their workspace vanished.
    const failure = classifyBackendFailure(null, null);
    expect(failure).toEqual({ kind: 'unavailable', status: null });
    expect(actionForFailure(failure).kind).toBe('error');
  });

  it('maps 401 to unauthenticated', () => {
    expect(classifyBackendFailure(401, null)).toEqual({ kind: 'unauthenticated' });
  });

  it('maps 403 with the rotation code to password-change-required', () => {
    expect(classifyBackendFailure(403, { code: PASSWORD_CHANGE_REQUIRED })).toEqual({
      kind: 'password-change-required',
    });
  });

  it('maps a plain 403 to forbidden (hidden tenant), not to an error', () => {
    expect(classifyBackendFailure(403, { message: 'nope' })).toEqual({ kind: 'forbidden' });
  });

  it('maps 404 to not-found', () => {
    expect(classifyBackendFailure(404, null)).toEqual({ kind: 'not-found' });
  });

  it('maps 5xx to unavailable, carrying the status', () => {
    expect(classifyBackendFailure(503, null)).toEqual({ kind: 'unavailable', status: 503 });
  });

  it('maps any other 4xx to unavailable so it is retryable, not a 404', () => {
    expect(classifyBackendFailure(422, null)).toEqual({ kind: 'unavailable', status: 422 });
  });

  it('does not treat a 403 body that merely mentions the string as the rotation gate', () => {
    // Only a structured `code` field counts - a message that happens to
    // contain the word must not bounce the user to /change-password.
    expect(classifyBackendFailure(403, { message: 'PASSWORD_CHANGE_REQUIRED' })).toEqual({
      kind: 'forbidden',
    });
  });

  it('ignores a null/array body on 403 rather than throwing', () => {
    expect(classifyBackendFailure(403, null)).toEqual({ kind: 'forbidden' });
    expect(classifyBackendFailure(403, [])).toEqual({ kind: 'forbidden' });
  });
});

describe('actionForFailure', () => {
  const cases: Array<[TenantFailure, string]> = [
    [{ kind: 'unauthenticated' }, 'login'],
    [{ kind: 'password-change-required' }, 'change-password'],
    [{ kind: 'forbidden' }, 'not-found'],
    [{ kind: 'not-found' }, 'not-found'],
    [{ kind: 'unavailable', status: null }, 'error'],
    [{ kind: 'unavailable', status: 500 }, 'error'],
  ];

  it.each(cases)('routes %o to %s', (failure, expected) => {
    expect(actionForFailure(failure).kind).toBe(expected);
  });

  it('keeps a cross-tenant org indistinguishable from a missing one', () => {
    // No existence oracle: an org a user may not see 404s exactly like a
    // slug that was never created.
    expect(actionForFailure({ kind: 'forbidden' })).toEqual(
      actionForFailure({ kind: 'not-found' }),
    );
  });

  it('never maps an expired session to a 404', () => {
    // The regression this module exists for.
    expect(actionForFailure({ kind: 'unauthenticated' }).kind).not.toBe('not-found');
  });
});
