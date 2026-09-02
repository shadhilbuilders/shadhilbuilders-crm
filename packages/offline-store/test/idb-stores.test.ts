import { describe, it, expect, beforeEach } from 'vitest';
import { clear, get, set } from 'idb-keyval';
import { mutationStore, photoStore, rqCacheStore } from '../src/idb-stores';

describe('idb-stores', () => {
  beforeEach(async () => {
    // Each test starts with empty stores. `clear()` is the top-level
    // idb-keyval function that accepts a store arg.
    await clear(mutationStore);
    await clear(photoStore);
    await clear(rqCacheStore);
  });

  it('mutationStore persists across reads', async () => {
    await set('test', { a: 1 }, mutationStore);
    expect(await get('test', mutationStore)).toEqual({ a: 1 });
  });

  it('photoStore and rqCacheStore are independent object stores', async () => {
    await set('a', new Blob(['x']), photoStore);
    await set('b', { x: 1 }, rqCacheStore);
    // The same key in a different store must not be visible.
    expect(await get('a', rqCacheStore)).toBeUndefined();
    expect(await get('b', photoStore)).toBeUndefined();
  });

  it('clears all entries on clear()', async () => {
    await set('one', 1, mutationStore);
    await set('two', 2, mutationStore);
    await clear(mutationStore);
    expect(await get('one', mutationStore)).toBeUndefined();
    expect(await get('two', mutationStore)).toBeUndefined();
  });
});
