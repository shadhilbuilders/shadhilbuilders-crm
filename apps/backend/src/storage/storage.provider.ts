// Storage abstraction for chat media attachments.
//
// MEDIA (2026-09-17): chat attachments (images / documents) are persisted
// through a StorageProvider so the transport is swappable:
//   - LocalDiskStorage  (dev/test now): writes to MEDIA_DIR (default ./media)
//   - imagekit.io       (prod, decision 1A → imagekit): a drop-in adapter
//                       implementing the SAME interface behind MEDIA_STORAGE
//
// The interface is deliberately minimal and async so either impl can be
// swapped by changing one factory, without touching chat/outbound/webhook
// consumers that only depend on StorageProvider.

/** Result of a saved file. */
export interface StoredFile {
  /** Storage key, unique within the bucket/disk. Rendered as the mediaUrl. */
  key: string;
  /** MIME type recorded at upload (used for type-aware rendering). */
  mimeType: string;
  /** Original filename for documents (display + downstream Meta filename). */
  filename: string;
  /** Byte length, for logging / size telemetry. */
  size: number;
}

/** Byte range requested by a client, both ends inclusive (HTTP semantics). */
export interface ByteRange {
  start: number;
  /** Omitted means "to the end of the object". */
  end?: number;
}

/** What the provider knows about a stored object without reading its bytes. */
export interface StoredObjectInfo {
  /** Real size in bytes as the storage layer holds it, never a client claim. */
  size: number;
  mimeType: string;
  /** True when the object is not reachable without a signature. */
  isPrivate: boolean;
}

/**
 * A streamed read. `status` is 206 when a range was honoured, 416 when it
 * lies outside the object (body is null then), and 200 otherwise. Headers are
 * the end-to-end ones the route should forward (content-type, content-length,
 * content-range, accept-ranges, etag); a signature never appears in them.
 */
export interface StreamedObject {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
}

/** Inputs for a browser-direct upload grant. */
export interface UploadAuthRequest {
  organizationId: string;
  /** Server-issued folder id; the record route refuses keys outside it. */
  uploadId: string;
  maxBytes: number;
}

/**
 * Either the browser uploads straight to the CDN with a short-lived signature
 * (`direct`), or posts the bytes through the API (`inline`, local disk). The
 * client has one code path per branch, and dev/CI exercise the `inline` one.
 */
export type UploadAuth =
  | {
      transport: 'direct';
      publicKey: string;
      urlEndpoint: string;
      token: string;
      expire: number;
      signature: string;
      /** `/<organizationId>/<uploadId>/` */
      folder: string;
      maxBytes: number;
      /** Uploads MUST be private; the record route verifies it via stat(). */
      isPrivateFile: true;
    }
  | { transport: 'inline'; maxBytes: number };

/** Lifetime of an upload grant, seconds. */
export const UPLOAD_AUTH_TTL_SECONDS = 600;

export interface StorageProvider {
  /**
   * Persist file bytes and return a StoredFile. The key is unique per
   * call and encodes the org (so cross-tenant reads are blocked by key
   * namespace even before an RLS-style guard).
   */
  save(
    data: Buffer,
    meta: { organizationId: string; mimeType: string; filename: string; uploadId?: string },
  ): Promise<StoredFile>;

  /**
   * Read the stored bytes back by key. Returns null when the key does
   * not exist. Used to (a) serve the file to the web pane and (b) hand
   * the bytes to Meta's /media upload for outbound media messages.
   */
  read(key: string): Promise<Buffer | null>;

  /** Public URL for a key, or null when the impl has no public base. */
  publicUrl?(key: string): string | null;

  /**
   * Delete the stored bytes by key. Compensation path for progress-photo
   * uploads (issue #7): storage.save() runs BEFORE the DB write, so a failed
   * DB transaction must remove the orphaned blob. Implementations MUST NOT
   * throw - a best-effort compensation failure is logged by the caller and
   * the blob is orphaned, never a user-facing error (the upload already
   * failed at that point).
   */
  delete(key: string): Promise<void>;

  /**
   * Size, type and privacy of a stored object, or null when the key does not
   * exist. The size is what the storage layer measured. THROWS when storage
   * itself fails (outage, auth, 5xx): "absent" and "could not ask" are
   * different answers and the routes map them to different errors.
   */
  stat(key: string): Promise<StoredObjectInfo | null>;

  /**
   * Stream an object, optionally a byte range of it. Returns null only when the
   * key does not exist; THROWS when storage itself fails. Private objects are
   * signed inside the provider; the signature never leaves.
   */
  readStream(key: string, range?: ByteRange): Promise<StreamedObject | null>;

  /** Grant for a browser-direct upload. Absent on providers that cannot. */
  createUploadAuth?(req: UploadAuthRequest): UploadAuth;

  /**
   * Delete everything under `/<organizationId>/<uploadId>/`. Idempotent: an
   * absent folder resolves. Used to cancel an upload that never became a row;
   * the browser cannot do it itself because it holds no delete credential.
   * Like `delete`, MUST NOT throw: a failure is logged and the blobs are left
   * for the orphan sweep.
   */
  deleteUploadFolder(organizationId: string, uploadId: string): Promise<void>;
}
