// Upload one video take: grant -> clip + poster -> record (plan sections 5, 8).
//
// Two transports, one code path above them. `direct` posts the bytes to the CDN
// with a short-lived signature (progress comes from XHR); `inline` posts base64
// through the API (local disk, dev and CI). The server names the folder, the
// client never invents a key.
//
// RETRY REUSES THE TAKE. The session carries the upload id and the batch id, and
// remembers which objects already landed, so Retry re-sends only what is missing
// and `record` is a replay if it had actually succeeded before the connection
// dropped. A new id per retry would double-save the same clip.
import { ApiError } from '@/apis/client';
import type { TimelinePhoto } from '@/hooks/queries/customer-progress';

import { UploadCancelledError, UploadNetworkError } from './errors';
import type { Clip } from './recorder-machine';

export type UploadAuth =
  | {
      transport: 'direct';
      publicKey: string;
      urlEndpoint: string;
      /**
       * ONE TICKET PER OBJECT. ImageKit burns a token on the first upload that
       * presents it, so the clip and the poster each get their own. The folder
       * is shared: the record route checks both keys against the upload id.
       */
      tickets: Record<'clip' | 'poster', { token: string; signature: string; expire: number }>;
      folder: string;
      maxBytes: number;
      isPrivateFile: true;
    }
  | { transport: 'inline'; maxBytes: number };

export interface UploadGrant {
  uploadId: string;
  auth: UploadAuth;
  maxDurationMs: number;
  maxBytes: number;
}

export interface UploadSession {
  grant: UploadGrant;
  /** Client-generated, stable for the take: groups the update across devices. */
  batchId: string;
  issuedAtMs: number;
  /** Keys of objects already stored, so a retry skips them. */
  clipKey: string | null;
  posterKey: string | null;
}

export interface TakeMeta {
  unitId: string;
  phaseId: string;
  takenAt: string;
  caption?: string;
  stage?: string;
}

export interface UploadDeps {
  api<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T>;
  /** One multipart POST with byte progress; rejects UploadNetworkError / UploadCancelledError. */
  postForm(
    url: string,
    form: FormData,
    onProgress: (loaded: number, total: number) => void,
    signal: AbortSignal | undefined,
  ): Promise<{ filePath: string }>;
  toBase64(blob: Blob): Promise<string>;
  now(): number;
  randomId(): string;
}

export const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
/** A grant is valid 600 s on the server; stop trusting one slightly early. */
const GRANT_REUSE_MS = 540_000;
const CLIP_FILE = 'clip.mp4';
const POSTER_FILE = 'poster.jpg';

export function newSession(
  grant: UploadGrant,
  deps: Pick<UploadDeps, 'now' | 'randomId'>,
): UploadSession {
  return {
    grant,
    batchId: deps.randomId(),
    issuedAtMs: deps.now(),
    clipKey: null,
    posterKey: null,
  };
}

export function grantStillUsable(session: UploadSession, nowMs: number): boolean {
  return nowMs - session.issuedAtMs < GRANT_REUSE_MS;
}

const videosPath = (unitId: string) => `/customer-progress/units/${unitId}/videos`;

export function requestGrant(deps: UploadDeps, unitId: string): Promise<UploadGrant> {
  return deps.api<UploadGrant>(`${videosPath(unitId)}/upload-auth`, { method: 'POST', json: {} });
}

export function cancelPending(deps: UploadDeps, unitId: string, uploadId: string): Promise<void> {
  return deps
    .api<unknown>(`${videosPath(unitId)}/pending/${uploadId}`, { method: 'DELETE' })
    .then(() => undefined);
}

async function sendOne(
  deps: UploadDeps,
  session: UploadSession,
  unitId: string,
  slot: 'clip' | 'poster',
  blob: Blob,
  onProgress: (loaded: number) => void,
  signal: AbortSignal | undefined,
): Promise<string> {
  const { auth, uploadId } = session.grant;
  if (auth.transport === 'inline') {
    const base64 = await deps.toBase64(blob);
    const out = await deps.api<{ key: string }>(`${videosPath(unitId)}/uploads/${uploadId}`, {
      method: 'POST',
      json: { slot, base64 },
    });
    onProgress(blob.size);
    return out.key;
  }
  const ticket = auth.tickets[slot];
  const form = new FormData();
  form.set('file', blob, slot === 'clip' ? CLIP_FILE : POSTER_FILE);
  form.set('fileName', slot === 'clip' ? CLIP_FILE : POSTER_FILE);
  form.set('publicKey', auth.publicKey);
  form.set('signature', ticket.signature);
  form.set('expire', String(ticket.expire));
  form.set('token', ticket.token);
  form.set('folder', auth.folder);
  form.set('isPrivateFile', 'true');
  form.set('useUniqueFileName', 'false');
  const out = await deps.postForm(
    IMAGEKIT_UPLOAD_URL,
    form,
    (loaded) => onProgress(loaded),
    signal,
  );
  return out.filePath;
}

export interface UploadArgs {
  deps: UploadDeps;
  meta: TakeMeta;
  clip: Clip;
  session: UploadSession;
  /** 0-100 of BYTES actually sent (clip + poster); never faked. */
  onProgress(percent: number): void;
  /** Called after each object lands, so the caller can keep the session for Retry. */
  onSession(next: UploadSession): void;
  signal?: AbortSignal;
}

/** Send what is missing, then record. Returns the saved row (new or replayed). */
export async function uploadTake(args: UploadArgs): Promise<TimelinePhoto> {
  const { deps, meta, clip, signal } = args;
  let session = args.session;
  if (clip.blob.size > session.grant.maxBytes) {
    throw new ApiError('That video is too large.', 413, 'VIDEO_TOO_LARGE', undefined, false);
  }
  const total = clip.blob.size + clip.poster.size;
  let base = 0;
  const report = (loaded: number) =>
    args.onProgress(Math.min(100, Math.round(((base + loaded) / total) * 100)));
  const check = () => {
    if (signal?.aborted) throw new UploadCancelledError();
  };

  const slots = [
    { slot: 'clip', blob: clip.blob, key: session.clipKey },
    { slot: 'poster', blob: clip.poster, key: session.posterKey },
  ] as const;
  for (const item of slots) {
    check();
    if (item.key !== null) {
      base += item.blob.size;
      report(0);
      continue;
    }
    const key = await sendOne(deps, session, meta.unitId, item.slot, item.blob, report, signal);
    base += item.blob.size;
    session = item.slot === 'clip' ? { ...session, clipKey: key } : { ...session, posterKey: key };
    args.onSession(session);
    report(0);
  }
  check();
  if (session.clipKey === null || session.posterKey === null) {
    throw new Error('Upload finished without both keys');
  }
  return deps.api<TimelinePhoto>(videosPath(meta.unitId), {
    method: 'POST',
    json: {
      uploadId: session.grant.uploadId,
      key: session.clipKey,
      posterKey: session.posterKey,
      batchId: session.batchId,
      phaseId: meta.phaseId,
      sizeBytes: clip.blob.size,
      durationMs: Math.round(clip.durationMs),
      hasAudio: clip.hasAudio,
      takenAt: meta.takenAt,
      ...(meta.caption !== undefined ? { caption: meta.caption } : {}),
      ...(meta.stage !== undefined ? { stage: meta.stage } : {}),
    },
  });
}

// ── Browser implementations of the injected pieces ────────────────────────

export function xhrPostForm(
  url: string,
  form: FormData,
  onProgress: (loaded: number, total: number) => void,
  signal: AbortSignal | undefined,
): Promise<{ filePath: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new UploadNetworkError());
    xhr.ontimeout = () => reject(new UploadNetworkError('Upload timed out'));
    xhr.onabort = () => reject(new UploadCancelledError());
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as { filePath?: unknown };
          if (typeof parsed.filePath === 'string') return resolve({ filePath: parsed.filePath });
        } catch {
          /* fall through */
        }
        return reject(
          new ApiError(
            'Storage returned an unreadable answer',
            502,
            'STORAGE_UNAVAILABLE',
            undefined,
            true,
          ),
        );
      }
      // 5xx and 429 from the CDN are worth another try; 4xx is a bad grant.
      const retryable = xhr.status >= 500 || xhr.status === 429;
      reject(
        new ApiError(
          'Upload to storage failed',
          xhr.status,
          retryable ? 'STORAGE_UNAVAILABLE' : 'VIDEO_UPLOAD_NOT_FOUND',
          undefined,
          retryable,
        ),
      );
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the clip'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}
