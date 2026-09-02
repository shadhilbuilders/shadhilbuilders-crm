// Auto-import fake-indexeddb for all Vitest test files in apps/web.
// Required because the offline-store (consumed via `@shadhil/offline-store`)
// uses IndexedDB and the test environment is jsdom (no real IDB).
import 'fake-indexeddb/auto';
