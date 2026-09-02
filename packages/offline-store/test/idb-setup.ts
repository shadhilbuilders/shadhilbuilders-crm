// Auto-import fake-indexeddb for all Vitest test files in this package.
// Per Vitest 4 docs, importing in a setup file applies to every test in
// the same project. `fake-indexeddb/auto` polyfills the global `indexedDB`,
// `IDBKeyRange`, etc., on import.
import 'fake-indexeddb/auto';
