// TakeUploader.
// protects= Retry continues the same take (same upload id, only missing objects),
// a grant is re-requested only when expired, a dead take ends its session, and
// cancel aborts the transfer and discards the server folder.
// fails_when= a retry asks for a new grant mid-window, a non-retryable failure
// leaves a session behind for the next take, or cancel throws when the server
// call fails.
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/apis/client';

import { UploadNetworkError } from './errors';
import type { Clip } from './recorder-machine';
import { TakeUploader } from './take-uploader';
import type { UploadDeps } from './upload';

const CLIP: Clip = {
  blob: new Blob([new Uint8Array(10)]),
  durationMs: 5_000,
  hasAudio: false,
  poster: new Blob([new Uint8Array(5)], { type: 'image/jpeg' }),
};
const META = { phaseId: 'ph', takenAt: '2026-11-23T10:00:00+05:30' };

function setup(
  opts: { failPosterOnce?: boolean; recordError?: Error; clock?: { t: number } } = {},
) {
  const clock = opts.clock ?? { t: 1_000 };
  let posterFailed = false;
  const paths: string[] = [];
  const deps: UploadDeps = {
    api: vi.fn(async (path: string, init?: { method?: string; json?: unknown }) => {
      paths.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.endsWith('/upload-auth')) {
        return {
          uploadId: `up${paths.filter((p) => p.endsWith('/upload-auth')).length}`,
          auth: { transport: 'inline', maxBytes: 14_680_064 },
          maxDurationMs: 45_000,
          maxBytes: 14_680_064,
        } as never;
      }
      if (path.includes('/uploads/')) {
        const slot = (init?.json as { slot: string }).slot;
        if (slot === 'poster' && opts.failPosterOnce && !posterFailed) {
          posterFailed = true;
          throw new UploadNetworkError();
        }
        return { key: `org/x/${slot}` } as never;
      }
      if (init?.method === 'DELETE') return {} as never;
      if (opts.recordError) throw opts.recordError;
      return { id: 'vid-1' } as never;
    }),
    postForm: vi.fn(),
    toBase64: vi.fn(async () => 'QQ=='),
    now: () => clock.t,
    randomId: () => 'batch-0001',
  };
  return { uploader: new TakeUploader(deps, 'u1'), paths, clock };
}

describe('TakeUploader', () => {
  it('asks for one grant, uploads both objects, records, and ends the session', async () => {
    const { uploader, paths } = setup();
    await uploader.send(CLIP, META, () => undefined);
    expect(paths.filter((p) => p.endsWith('/upload-auth'))).toHaveLength(1);
    expect(paths.at(-1)).toBe('POST /customer-progress/units/u1/videos');
    expect(uploader.hasSession).toBe(false);
  });

  it('Retry after a retryable failure reuses the grant and the landed clip', async () => {
    const { uploader, paths } = setup({ failPosterOnce: true });
    await expect(uploader.send(CLIP, META, () => undefined)).rejects.toBeInstanceOf(
      UploadNetworkError,
    );
    expect(uploader.hasSession).toBe(true);

    await uploader.send(CLIP, META, () => undefined);
    expect(paths.filter((p) => p.endsWith('/upload-auth'))).toHaveLength(1);
    const clipPosts = paths.filter((p) => p.includes('/uploads/up1'));
    // clip once, poster twice (failed then landed)
    expect(clipPosts).toHaveLength(3);
  });

  it('requests a fresh grant when the old one has aged out', async () => {
    const { uploader, paths, clock } = setup({ failPosterOnce: true });
    await expect(uploader.send(CLIP, META, () => undefined)).rejects.toBeInstanceOf(
      UploadNetworkError,
    );
    clock.t += 600_000;
    await uploader.send(CLIP, META, () => undefined);
    expect(paths.filter((p) => p.endsWith('/upload-auth'))).toHaveLength(2);
  });

  it('drops the session after a non-retryable failure', async () => {
    const dead = new ApiError('long', 400, 'VIDEO_TOO_LONG', undefined, false);
    const { uploader } = setup({ recordError: dead });
    await expect(uploader.send(CLIP, META, () => undefined)).rejects.toBe(dead);
    expect(uploader.hasSession).toBe(false);
  });

  it('keeps the session after a retryable record failure', async () => {
    const soft = new ApiError('save', 503, 'VIDEO_SAVE_FAILED', undefined, true);
    const { uploader } = setup({ recordError: soft });
    await expect(uploader.send(CLIP, META, () => undefined)).rejects.toBe(soft);
    expect(uploader.hasSession).toBe(true);
  });

  it('cancel discards the server folder and never throws', async () => {
    const { uploader, paths } = setup({ failPosterOnce: true });
    await expect(uploader.send(CLIP, META, () => undefined)).rejects.toBeInstanceOf(
      UploadNetworkError,
    );
    await uploader.cancel();
    expect(paths.at(-1)).toBe('DELETE /customer-progress/units/u1/videos/pending/up1');
    expect(uploader.hasSession).toBe(false);
    await expect(uploader.cancel()).resolves.toBeUndefined();
  });
});
