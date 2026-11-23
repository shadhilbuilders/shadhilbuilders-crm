// Owns ONE take's upload across attempts (plan sections 5, 6).
//
// The recorder calls `send` for the first attempt and again for every Retry. The
// session (upload id, batch id, which objects landed) lives here, so a Retry
// continues the same take instead of minting a new one. A failure that cannot be
// retried ends the session; the next take starts clean.
import { isRetryableVideoError, UploadCancelledError } from './errors';
import type { Clip } from './recorder-machine';
import {
  cancelPending,
  grantStillUsable,
  newSession,
  requestGrant,
  uploadTake,
  type TakeMeta,
  type UploadDeps,
  type UploadSession,
} from './upload';
import type { TimelinePhoto } from '@/hooks/queries/customer-progress';

export class TakeUploader {
  private session: UploadSession | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly deps: UploadDeps,
    private readonly unitId: string,
  ) {}

  /** True while a session exists, i.e. a Retry would continue a take. */
  get hasSession(): boolean {
    return this.session !== null;
  }

  async send(
    clip: Clip,
    meta: Omit<TakeMeta, 'unitId'>,
    onProgress: (percent: number) => void,
  ): Promise<TimelinePhoto> {
    this.abort = new AbortController();
    try {
      const session = await this.ensureSession();
      const photo = await uploadTake({
        deps: this.deps,
        meta: { ...meta, unitId: this.unitId },
        clip,
        session,
        onProgress,
        onSession: (next) => {
          this.session = next;
        },
        signal: this.abort.signal,
      });
      this.session = null;
      return photo;
    } catch (err) {
      // A take that cannot be retried is over; a retryable one keeps its session.
      if (!isRetryableVideoError(err) && !(err instanceof UploadCancelledError)) {
        this.session = null;
      }
      throw err;
    } finally {
      this.abort = null;
    }
  }

  private async ensureSession(): Promise<UploadSession> {
    if (this.session !== null && grantStillUsable(this.session, this.deps.now())) {
      return this.session;
    }
    const grant = await requestGrant(this.deps, this.unitId);
    this.session = newSession(grant, this.deps);
    return this.session;
  }

  /**
   * Stop the in-flight upload and discard the take's folder on the server.
   * Best effort: a failed cancel leaves blobs for the orphan sweep, never an error
   * on screen.
   */
  async cancel(): Promise<void> {
    this.abort?.abort();
    const session = this.session;
    this.session = null;
    if (session === null) return;
    try {
      await cancelPending(this.deps, this.unitId, session.grant.uploadId);
    } catch {
      /* the server's orphan sweep owns what is left */
    }
  }
}
