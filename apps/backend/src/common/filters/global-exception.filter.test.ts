// GlobalExceptionFilter - unit tests (2026-10-04).
//
// Pins the fix for the reported bug: an untranslated Prisma error (or any
// other uncaught throw) must become a JSON body with a useful `message`,
// never the bare Nest default `{"statusCode":500,"message":"Internal
// server error"}` the browser toasted verbatim.
//
// Test strategy: build a minimal fake ArgumentsHost (just enough surface -
// `switchToHttp().getResponse()/getRequest()`) and assert on what the
// mocked Express `response.status().json()` chain received. No real HTTP
// server needed.
import { describe, expect, it, vi } from 'vitest';
import { ConflictException, type ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@shadhil/database';

import { GlobalExceptionFilter } from './global-exception.filter';

function makeHost(): { host: ArgumentsHost; json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const response = { status };
  const request = { method: 'POST', url: '/api/users' };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

function prismaKnownError(code: string, message: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: 'test',
  });
}

describe('GlobalExceptionFilter', () => {
  it('passes an existing HttpException body through unchanged (e.g. CodedException)', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json, status } = makeHost();

    filter.catch(new ConflictException({ code: 'EMAIL_ALREADY_EXISTS', message: 'dup' }), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({ code: 'EMAIL_ALREADY_EXISTS', message: 'dup' });
  });

  it('translates an UNTRANSLATED Prisma P2002 into a 409 with a human message (not a 500)', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json, status } = makeHost();

    filter.catch(prismaKnownError('P2002', 'Unique constraint failed'), host);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DUPLICATE_VALUE', message: expect.any(String) }),
    );
    const [body] = json.mock.calls[0] as [{ message: string }];
    expect(body.message).not.toMatch(/internal server error/i);
  });

  it('translates a Prisma P2025 (record not found) into a 404', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json, status } = makeHost();

    filter.catch(prismaKnownError('P2025', 'An operation failed'), host);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'RECORD_NOT_FOUND' }));
  });

  it('maps a totally unknown thrown Error to a safe 500 WITHOUT leaking internals', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json, status } = makeHost();

    filter.catch(new Error('TypeError: cannot read property foo of undefined at /app/src/secret.ts:42'), host);

    expect(status).toHaveBeenCalledWith(500);
    const [body] = json.mock.calls[0] as [{ code: string; message: string }];
    expect(body.code).toBe('INTERNAL_ERROR');
    // Human, actionable, and - the whole point - does NOT leak the stack/path.
    expect(body.message).not.toContain('secret.ts');
    expect(body.message.length).toBeGreaterThan(0);
  });

  it('handles a thrown non-Error value (e.g. a rejected string) without crashing', () => {
    const filter = new GlobalExceptionFilter();
    const { host, json, status } = makeHost();

    filter.catch('plain string rejection', host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INTERNAL_ERROR' }));
  });
});
