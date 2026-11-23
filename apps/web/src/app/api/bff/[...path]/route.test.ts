// @vitest-environment node
// BFF proxy regression suite (site update video, step 6).
//
// protects= everything that already flows through /api/bff/* keeps its status,
// body bytes and content type: JSON POST, 204, HEAD, PDF/binary, error bodies,
// and the auth gate. This suite was written BEFORE the streaming change, so a
// green run on both sides of it is the proof nothing quiet broke.
// fails_when= a non-media route changes behaviour: a 204 throws, a PDF is
// re-encoded, HEAD is rejected, an upstream error is rewritten, or a missing
// session reaches the backend.
// no_claim= Range/206 streaming (route.range.test.ts) and the NestJS side.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findSession: vi.fn(),
  issueJwt: vi.fn(),
  cookie: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({})) }));
vi.mock('@/lib/session-cookie', () => ({ readSessionCookie: () => mocks.cookie() }));
vi.mock('@shadhil/database', () => ({ prisma: { session: { findFirst: mocks.findSession } } }));
vi.mock('@shadhil/auth', () => ({ issueJwt: mocks.issueJwt }));

import * as route from './route';

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) }) as never;
const req = (
  method: string,
  url: string,
  init: ConstructorParameters<typeof NextRequest>[1] = {},
) => new NextRequest(`http://web.test${url}`, { method, ...init });

const PDF = Uint8Array.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0xff, 0xfe, 0x00, 0x80,
]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookie.mockReturnValue({ value: 'tok.sig' });
  mocks.findSession.mockResolvedValue({
    expiresAt: new Date(Date.now() + 60_000),
    user: { id: 'u1', role: 'ADMIN', organizationId: 'org1', email: 'a@x.in' },
  });
  mocks.issueJwt.mockResolvedValue('jwt-123');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

describe('auth gate', () => {
  it('401 and no backend call without a session cookie', async () => {
    mocks.cookie.mockReturnValue(null);
    const res = await route.GET(req('GET', '/api/bff/leads'), ctx('leads'));
    expect(res.status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('401 for an unknown or expired session', async () => {
    mocks.findSession.mockResolvedValueOnce(null);
    expect((await route.GET(req('GET', '/api/bff/leads'), ctx('leads'))).status).toBe(401);
    mocks.findSession.mockResolvedValueOnce({
      expiresAt: new Date(Date.now() - 1),
      user: { id: 'u', role: 'ADMIN', organizationId: 'o', email: 'e' },
    });
    expect((await route.GET(req('GET', '/api/bff/leads'), ctx('leads'))).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe('JSON', () => {
  it('forwards a POST body and content type with a Bearer JWT, and returns the JSON', async () => {
    const res = await route.POST(
      req('POST', '/api/bff/leads?x=1', {
        body: JSON.stringify({ name: 'Asha' }),
        headers: { 'content-type': 'application/json' },
      }),
      ctx('leads'),
    );
    const [target, init] = mocks.fetch.mock.calls[0] as [
      URL,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(String(target)).toBe('http://localhost:8080/api/leads?x=1');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer jwt-123');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(await new Response(init.body).text()).toBe('{"name":"Asha"}');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('keeps the upstream status and body for an error (no rewriting)', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'VIDEO_TOO_LONG', retryable: false }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await route.POST(req('POST', '/api/bff/x', { body: '{}' }), ctx('x'));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: 'VIDEO_TOO_LONG', retryable: false });
  });

  it('preserves non-ASCII text', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response('{"name":"शादिल ₹"}', { headers: { 'content-type': 'application/json' } }),
    );
    const res = await route.GET(req('GET', '/api/bff/x'), ctx('x'));
    expect(await res.text()).toBe('{"name":"शादिल ₹"}');
  });
});

describe('204 and empty bodies', () => {
  it('relays a 204 as a 204 with no body', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await route.DELETE(req('DELETE', '/api/bff/leads/1'), ctx('leads', '1'));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('relays an empty 200 as an empty 200', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 200 }));
    const res = await route.PATCH(req('PATCH', '/api/bff/x', { body: '{}' }), ctx('x'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

describe('binary', () => {
  it('returns PDF bytes exactly, with their content type', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    const res = await route.GET(req('GET', '/api/bff/media/k'), ctx('media', 'k'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
  });

  it('keeps a media key with embedded slashes as ONE encoded segment', async () => {
    await route.GET(req('GET', '/api/bff/media/x'), ctx('media', '/org/id/a.png'));
    expect(String(mocks.fetch.mock.calls[0]![0])).toBe(
      'http://localhost:8080/api/media/%2Forg%2Fid%2Fa.png',
    );
  });
});

describe('HEAD', () => {
  it('is supported: same status and headers, no body', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': String(PDF.length) },
      }),
    );
    const head = (route as { HEAD?: typeof route.GET }).HEAD;
    expect(head).toBeTypeOf('function');
    const res = await head!(req('HEAD', '/api/bff/media/k'), ctx('media', 'k'));
    expect((mocks.fetch.mock.calls[0]![1] as { method: string }).method).toBe('HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(await res.text()).toBe('');
  });
});
