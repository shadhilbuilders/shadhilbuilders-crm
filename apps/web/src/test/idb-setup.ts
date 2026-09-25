// Auto-import fake-indexeddb for all Vitest test files in apps/web.
// Required because the offline-store (consumed via `@shadhil/offline-store`)
// uses IndexedDB and the test environment is jsdom (no real IDB).
import 'fake-indexeddb/auto';

// jsdom in this workspace exposes `window.sessionStorage` but NOT
// `window.localStorage`: Node's built-in localStorage shadows jsdom's and
// refuses to operate without `--localstorage-file`, so the property is
// undefined and any `localStorage.getItem(...)` in component code throws
// inside its try/catch (silently disabling the feature under test).
//
// Polyfill it for every test file rather than per-file, so tests that exercise
// durable-latch logic (install-prompt, push-enable-prompt) do not each have to
// re-declare a stub. In-memory, reset automatically because each test file gets
// a fresh jsdom environment.
if (typeof window !== 'undefined' && !window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      get length(): number {
        return store.size;
      },
      clear: (): void => store.clear(),
      getItem: (key: string): string | null => store.get(key) ?? null,
      key: (index: number): string | null => Array.from(store.keys())[index] ?? null,
      removeItem: (key: string): void => {
        store.delete(key);
      },
      setItem: (key: string, value: string): void => {
        store.set(key, String(value));
      },
    } satisfies Storage,
  });
}
