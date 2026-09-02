/**
 * @shadhil/offline-store — platform-agnostic offline data primitives.
 *
 * Barrel export. Both apps/web (PWA) and apps/mobile (Expo, future)
 * import from this single entry point.
 */
export { createMutationQueue, type MutationQueue } from './mutation-queue';
export type { Mutation, OfflineState, ReplayResult, OfflineMutationResult } from './types';
export { resolveLWW } from './conflict-resolver';
export {
  createPhotoStore,
  type PhotoStore,
} from './photo-store';
export { normalizeToWebP, normalizeOnIdle } from './photo-normalize';
export {
  mutationStore,
  photoStore,
  rqCacheStore,
  RQ_CACHE_KEY,
  MUTATION_QUEUE_KEY,
} from './idb-stores';
