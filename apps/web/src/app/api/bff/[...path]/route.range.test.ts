// @vitest-environment node
// BFF proxy: byte-range streaming (site update video, step 6).
//
// protects= a <video> element can seek: Range goes in, 206 + Content-Range come
// out, the body is relayed as a stream (not buffered whole), and a client that
// abandons the request cancels the upstream read.
// fails_when= Range is dropped (the browser gets 200 and cannot seek), the 206
// headers are lost, a 416 is rewritten, the clip is buffered in memory, or a
// compressed upstream gets a wrong Content-Length.
// no_claim= the regression suite (route.test.ts) and ImageKit behaviour.
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({})) }));
vi.mock('@/lib/session-cookie', () => ({ readSessionCookie: () => ({ value: 'tok.sig' }) }));
vi.mock('@shadhil/database', () => ({
  prisma: {
    session: {
      findFirst: vi.fn(async () => ({
        expiresAt: new Date(Date.now() + 60_000),
        user: { id: 'u1', role: 'ADMIN', organizationId: 'org1', email: 'a@x.in' },
      })),
    },
  },
}));
vi.mock('@shadhil/auth', () => ({ issueJwt: vi.fn(async () => 'jwt-123') }));

import * as route from './route';

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) }) as never;
const get = (headers: Record<string, string> = {}, signal?: AbortSignal) =>
  new NextRequest('http://web.test/api/bff/media/clip', { method: 'GET', headers, signal });

const BYTES = Uint8Array.from({ length: 100 }, (_, i) => i);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('Range', () => {
  it('forwards Range and If-Range upstream', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(BYTES.slice(10, 20), { status: 206 }));
    await route.GET(get({ range: 'bytes=10-19', 'if-range': '"etag1"' }), ctx('media', 'clip'));
    const headers = (mocks.fetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Range).toBe('bytes=10-19');
    expect(headers['If-Range']).toBe('"etag1"');
  });

  it('does not invent a Range header when the browser sent none', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(BYTES));
    await route.GET(get(), ctx('media', 'clip'));
    expect(
      (mocks.fetch.mock.calls[0]![1] as { headers: Record<string, string> }).headers.Range,
    ).toBeUndefined();
  });

  it('relays 206 with the exact slice and its range headers', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(BYTES.slice(10, 20), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 10-19/100',
          'content-length': '10',
          'accept-ranges': 'bytes',
          etag: '"etag1"',
        },
      }),
    );
    const res = await route.GET(get({ range: 'bytes=10-19' }), ctx('media', 'clip'));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100');
    expect(res.headers.get('content-length')).toBe('10');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('etag')).toBe('"etag1"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(10, 20));
  });

  it('relays 416 unchanged', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(null, { status: 416, headers: { 'content-range': 'bytes */100' } }),
    );
    const res = await route.GET(get({ range: 'bytes=500-' }), ctx('media', 'clip'));
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */100');
  });

  it('keeps responses uncacheable: media is per-user and signed', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(BYTES, { headers: { 'cache-control': 'public, max-age=1' } }),
    );
    const res = await route.GET(get(), ctx('media', 'clip'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('streaming', () => {
  it('hands the upstream body through as a stream, never buffering it whole', async () => {
    const upstream = new Response(BYTES);
    const arrayBuffer = vi.spyOn(upstream, 'arrayBuffer');
    mocks.fetch.mockResolvedValueOnce(upstream);
    const res = await route.GET(get(), ctx('media', 'clip'));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(res.body).toBeInstanceOf(ReadableStream);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it('passes the client abort signal upstream so a seek cancels the old read', async () => {
    const controller = new AbortController();
    mocks.fetch.mockResolvedValueOnce(new Response(BYTES));
    await route.GET(get({}, controller.signal), ctx('media', 'clip'));
    const signal = (mocks.fetch.mock.calls[0]![1] as { signal: AbortSignal }).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('drops Content-Length when the upstream was content-encoded', async () => {
    mocks.fetch.mockResolvedValueOnce(
      new Response(BYTES, {
        headers: {
          'content-encoding': 'gzip',
          'content-length': '12',
          'content-type': 'text/plain',
        },
      }),
    );
    const res = await route.GET(get(), ctx('media', 'clip'));
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('content-encoding')).toBeNull();
  });
});
