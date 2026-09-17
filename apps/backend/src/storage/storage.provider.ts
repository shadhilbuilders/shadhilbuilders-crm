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

export interface StorageProvider {
  /**
   * Persist file bytes and return a StoredFile. The key is unique per
   * call and encodes the org (so cross-tenant reads are blocked by key
   * namespace even before an RLS-style guard).
   */
  save(
    data: Buffer,
    meta: { organizationId: string; mimeType: string; filename: string },
  ): Promise<StoredFile>;

  /**
   * Read the stored bytes back by key. Returns null when the key does
   * not exist. Used to (a) serve the file to the web pane and (b) hand
   * the bytes to Meta's /media upload for outbound media messages.
   */
  read(key: string): Promise<Buffer | null>;

  /** Public URL for a key, or null when the impl has no public base. */
  publicUrl?(key: string): string | null;
}
