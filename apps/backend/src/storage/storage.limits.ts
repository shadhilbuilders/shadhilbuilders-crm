// Shared upload limits for every storage-consuming route (issue #7 slice 1:
// media.controller's MAX_UPLOAD_BYTES was module-local; customer-progress
// needs the same cap, and duplicating a constant across two routes is how
// they drift). One definition, two consumers.
/** Hard upload cap: 10MB per file. base64 inflates ~4/3, so a 10MB file is
 *  ~13.4MB of JSON through the BFF (both hops allow 25MB). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Site update video: 14MiB, under Meta's 16MB video ceiling and above a 45s
 *  clip at 2.5 Mbps (13.61MB measured). Mirrors the ProgressPhoto_size_cap
 *  CHECK constraint - change both together. */
export const MAX_VIDEO_BYTES = 14_680_064;
