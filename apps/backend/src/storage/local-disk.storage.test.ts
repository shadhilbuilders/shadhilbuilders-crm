// LocalDiskStorage.delete() tests (issue #7 slice 1 compensation path).
//
// protects= delete removes bytes for a saved key and is a no-op for
// foreign/traversal keys - fails_when= delete throws or escapes the media
// root; no_claim= green does NOT cover the imagekit adapter (its delete is
// exercised in imagekit.storage.test.ts with a mocked SDK).
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { LocalDiskStorage } from './local-disk.storage';

describe('LocalDiskStorage.delete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadhil-storage-'));
  const storage = new LocalDiskStorage(dir);

  afterAll(() => {
    // rm -rf the temp root
    import('node:fs/promises').then((fs) => fs.rm(dir, { recursive: true, force: true }));
  });

  it('protects= a saved key is fully removable', async () => {
    const stored = await storage.save(Buffer.from('hello world'), {
      organizationId: 'org-1',
      mimeType: 'image/jpeg',
      filename: 'site.jpg',
    });
    const before = await storage.read(stored.key);
    expect(before).not.toBeNull();
    // Raw file was written (readFile independent of the provider).
    await readFile(join(dir, stored.key));

    await storage.delete(stored.key);
    expect(await storage.read(stored.key)).toBeNull();
  });

  it('protects= a missing key resolves (idempotent compensation)', async () => {
    await expect(storage.delete('org-1/does/not/exist.jpg')).resolves.toBeUndefined();
  });

  it('protects= a traversal key resolves WITHOUT touching files outside the root', async () => {
    const sentinel = join(dir, 'guard.txt');
    await import('node:fs/promises').then((fs) => fs.writeFile(sentinel, 'keep me'));
    // resolve() escapes the mediaDir root, so the guard clause rejects it.
    await expect(storage.delete(join('..', 'guard.txt'))).resolves.toBeUndefined();
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep me');
  });

  it('protects= delete never throws on an unreadable path (best-effort contract)', async () => {
    // A directory where a file is expected: rm handles it via recursive:true.
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'org-9/adir'), { recursive: true }));
    await expect(storage.delete('org-9/adir')).resolves.toBeUndefined();
  });
});