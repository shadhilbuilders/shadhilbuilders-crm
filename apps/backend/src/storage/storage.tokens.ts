// Injection token for the storage provider. Lives on its own file (NOT in
// storage.module.ts) so storage.module ← media.controller ← storage.module
// and outbound.service → storage.module import cycles are broken - importing
// the token does not pull the @Module (which imports the controller, which
// would otherwise TDZ-crash on `STORAGE_PROVIDER` before initialization).
export const STORAGE_PROVIDER = 'STORAGE_PROVIDER';
