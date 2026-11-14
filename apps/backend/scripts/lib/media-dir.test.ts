// scripts/lib/media-dir.ts - the media root must not depend on the CWD.
//
// The bug this pins: `LocalDiskStorage` defaults MEDIA_DIR to the relative
// `./media`, which resolves against the process CWD. Running a repair script
// from the repo root looked in `<repo>/media`, found nothing, and would report
// every blob as "lost beyond recovery" while they sat in `apps/backend/media`.
// A repair tool that confidently reports the wrong answer is worse than one
// that refuses, so the scripts anchor the default to the backend PACKAGE.
//
// The anchor is `import.meta.url` (this file's own location). Note what is NOT
// used: `process.cwd()` (the bug) and `process.argv[1]` (the script path only
// when a script is launched directly - under vitest it is the worker binary,
// which is exactly how an argv-based anchor fails).
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { backendPackageRoot, describeMediaDir, resolveMediaDir } from './media-dir';

const OLD_MEDIA_DIR = process.env.MEDIA_DIR;

afterEach(() => {
  if (OLD_MEDIA_DIR === undefined) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = OLD_MEDIA_DIR;
});

describe('backendPackageRoot', () => {
  it("resolves the @shadhil/backend package from this file's own location", () => {
    const root = backendPackageRoot();
    expect(root.endsWith(join('apps', 'backend'))).toBe(true);
    // It is an absolute path, not a relative one that could shift with CWD.
    expect(root.startsWith('/')).toBe(true);
  });
});

describe('resolveMediaDir', () => {
  it('defaults to the backend package media dir, not the CWD', () => {
    delete process.env.MEDIA_DIR;
    const { dir, source } = resolveMediaDir();
    expect(source).toBe('package-default');
    expect(dir).toBe(join(backendPackageRoot(), 'media'));
  });

  it('returns an absolute path, so it cannot shift with the CWD', () => {
    delete process.env.MEDIA_DIR;
    expect(resolveMediaDir().dir.startsWith('/')).toBe(true);
    // The old literal default was the bare string 'media', which resolves
    // differently from every CWD. The package-anchored value never is that.
    expect(resolveMediaDir().dir).not.toBe('media');
  });

  it('honours an explicit MEDIA_DIR (resolved, so it is absolute)', () => {
    process.env.MEDIA_DIR = './somewhere/else';
    const { dir, source } = resolveMediaDir();
    expect(source).toBe('env');
    expect(dir.startsWith('/')).toBe(true);
    expect(dir.endsWith(join('somewhere', 'else'))).toBe(true);
  });

  it('treats an empty/whitespace MEDIA_DIR as unset', () => {
    process.env.MEDIA_DIR = '   ';
    expect(resolveMediaDir().source).toBe('package-default');
  });
});

describe('describeMediaDir', () => {
  it('names the source so an operator can see which root was used', () => {
    delete process.env.MEDIA_DIR;
    expect(describeMediaDir()).toContain('package default');
    expect(describeMediaDir()).toContain(resolveMediaDir().dir);
  });

  it('says so when the directory is missing, instead of silently scanning nothing', () => {
    process.env.MEDIA_DIR = join(backendPackageRoot(), 'definitely-not-here');
    expect(describeMediaDir()).toContain('DOES NOT EXIST');
  });
});
