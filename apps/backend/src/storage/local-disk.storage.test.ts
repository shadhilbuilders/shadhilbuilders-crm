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

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  // ── SIBLING-PREFIX ESCAPE (security, 2026-11-06) ──────────────────────────
  //
  // The old guard was `target.startsWith(mediaDir)`. When the root is
  // `/tmp/x/media`, the sibling `/tmp/x/media-evil/secret.txt` starts with
  // `/tmp/x/media`, so `..` normalised straight through it. Exploited for
  // real: read() returned the file and delete() removed it. The fix compares
  // against `root + sep`.
  it('protects= read() cannot reach a SIBLING dir sharing the root name as a prefix', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'shadhil-escape-'));
    const root = join(parent, 'media');
    const sibling = join(parent, 'media-evil');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(join(sibling, 'secret.txt'), 'TOP-SECRET');
    });

    const scoped = new LocalDiskStorage(root);
    // Every shape that used to escape.
    for (const key of ['../media-evil/secret.txt', '../media-evil/secret.txt', '..%2Fmedia-evil/secret.txt']) {
      expect(await scoped.read(key)).toBeNull();
    }
    // The sibling file is untouched.
    await expect(readFile(join(sibling, 'secret.txt'), 'utf8')).resolves.toBe('TOP-SECRET');

    await import('node:fs/promises').then((fs) => fs.rm(parent, { recursive: true, force: true }));
  });

  it('protects= delete() cannot remove a SIBLING dir file through `..`', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'shadhil-escape-'));
    const root = join(parent, 'media');
    const sibling = join(parent, 'media-evil');
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(join(sibling, 'secret.txt'), 'TOP-SECRET');
    });

    const scoped = new LocalDiskStorage(root);
    await scoped.delete('../media-evil/secret.txt');

    // Still there - the delete was refused, not quietly performed.
    await expect(readFile(join(sibling, 'secret.txt'), 'utf8')).resolves.toBe('TOP-SECRET');

    await import('node:fs/promises').then((fs) => fs.rm(parent, { recursive: true, force: true }));
  });

  it('protects= an ABSOLUTE key is refused (resolve() would ignore the root)', async () => {
    const scoped = new LocalDiskStorage(dir);
    expect(await scoped.read('/etc/passwd')).toBeNull();
    expect(await scoped.read(`${dir}/org-1/x.png`)).toBeNull();
  });

  it('protects= a normal key still resolves and round-trips inside the root', async () => {
    // The containment rule must not break the happy path.
    const stored = await storage.save(Buffer.from('ok'), {
      organizationId: 'org-7',
      mimeType: 'image/png',
      filename: 'a.png',
    });
    await expect(storage.read(stored.key)).resolves.toEqual(Buffer.from('ok'));
  });

  it('protects= delete never throws on an unreadable path (best-effort contract)', async () => {
    // A directory where a file is expected: rm handles it via recursive:true.
    await import('node:fs/promises').then((fs) => fs.mkdir(join(dir, 'org-9/adir'), { recursive: true }));
    await expect(storage.delete('org-9/adir')).resolves.toBeUndefined();
  });
});

// ── SYMLINK ESCAPE (2026-11-06) ──────────────────────────────────────────────
//
// A lexical check cannot see a symlink planted INSIDE the root. Every string
// test passes (`<root>/org/cuid/x.png` looks perfectly contained) and the
// kernel then follows the link out of the tree. These tests build that layout
// for real and assert nothing outside the root is reachable or destructible.
describe('LocalDiskStorage symlink containment', () => {
  let parent: string;
  let root: string;
  let outside: string;
  let scoped: LocalDiskStorage;

  beforeEach(async () => {
    const fs = await import('node:fs/promises');
    parent = mkdtempSync(join(tmpdir(), 'shadhil-symlink-'));
    root = join(parent, 'media');
    outside = join(parent, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, 'secret.txt'), 'TOP-SECRET');
    scoped = new LocalDiskStorage(root);
  });

  afterEach(async () => {
    const fs = await import('node:fs/promises');
    await fs.rm(parent, { recursive: true, force: true });
  });

  it('protects= read() does not follow a symlinked FILE out of the root', async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(root, 'org-1', 'id-1'), { recursive: true });
    // A key whose final component is a link to the outside secret.
    await fs.symlink(join(outside, 'secret.txt'), join(root, 'org-1', 'id-1', 'leak.png'));

    expect(await scoped.read('org-1/id-1/leak.png')).toBeNull();
  });

  it('protects= read() does not follow a symlinked DIRECTORY out of the root', async () => {
    const fs = await import('node:fs/promises');
    // <root>/org-1 -> <outside>: every key under it resolves elsewhere.
    await fs.symlink(outside, join(root, 'org-1'));

    expect(await scoped.read('org-1/secret.txt')).toBeNull();
  });

  it('protects= delete() does not unlink through a symlinked file', async () => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(root, 'org-1', 'id-1'), { recursive: true });
    await fs.symlink(join(outside, 'secret.txt'), join(root, 'org-1', 'id-1', 'leak.png'));

    await scoped.delete('org-1/id-1/leak.png');

    // The real file survives.
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('TOP-SECRET');
  });

  it('protects= delete() does not recurse through a symlinked directory', async () => {
    const fs = await import('node:fs/promises');
    await fs.symlink(outside, join(root, 'org-1'));

    await scoped.delete('org-1');

    // The whole outside directory is intact.
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('TOP-SECRET');
  });

  it('protects= save() refuses to write through a symlinked target directory', async () => {
    const fs = await import('node:fs/promises');
    // Pre-plant an org directory that points outside. `mkdir(recursive)` on an
    // existing symlink does NOT throw, so without the check the write would land
    // in <outside>.
    await fs.symlink(outside, join(root, 'org-evil'));

    await expect(
      scoped.save(Buffer.from('payload'), {
        organizationId: 'org-evil',
        mimeType: 'image/png',
        filename: 'x.png',
      }),
    ).rejects.toThrow(/symlink outside the media root/);

    // Nothing appeared outside.
    await expect(fs.access(join(outside, 'x.png'))).rejects.toThrow();
  });

  it('still allows a legitimate symlink that points INSIDE the root', async () => {
    // Containment must not ban symlinks outright - only escapes.
    const fs = await import('node:fs/promises');
    const realDir = join(root, 'org-2', 'id-2');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(join(realDir, 'real.png'), 'INSIDE');
    await fs.mkdir(join(root, 'alias'), { recursive: true });
    await fs.symlink(realDir, join(root, 'alias', 'link'));

    await expect(scoped.read('alias/link/real.png')).resolves.toEqual(Buffer.from('INSIDE'));
  });

  it('round-trips save -> read -> delete with no symlinks involved', async () => {
    const stored = await scoped.save(Buffer.from('plain'), {
      organizationId: 'org-3',
      mimeType: 'image/png',
      filename: 'p.png',
    });
    await expect(scoped.read(stored.key)).resolves.toEqual(Buffer.from('plain'));
    await scoped.delete(stored.key);
    expect(await scoped.read(stored.key)).toBeNull();
  });
});