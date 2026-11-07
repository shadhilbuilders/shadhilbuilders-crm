// Where the local-disk media root actually is, for maintenance scripts.
//
// WHY THIS EXISTS. `LocalDiskStorage` defaults `MEDIA_DIR` to the relative
// path `./media`, which resolves against the PROCESS CWD. That is fine for the
// app - `pnpm --filter @shadhil/backend dev` runs with CWD = `apps/backend`,
// so `./media` lands in `apps/backend/media` - but it makes a script's
// behaviour depend on where the operator happened to invoke it from. Running
// `npx tsx apps/backend/scripts/...` from the repo root looks in
// `<repo>/media`, finds nothing, and reports every blob as "lost beyond
// recovery" when they are sitting right there in `apps/backend/media`.
//
// A repair script that confidently reports the wrong answer is worse than one
// that refuses, so scripts anchor the default to the BACKEND PACKAGE instead
// of the CWD. That matches where the app writes when run the documented way,
// and it no longer matters which directory the operator is in.
//
// ANCHOR: `import.meta.url`, i.e. this file's own location - never
// `process.argv[1]` (which is only the script path when a script was launched
// directly, and is the test runner's binary under vitest) and never
// `process.cwd()`. These scripts are not part of the `tsc` build (tsconfig
// `include` covers `src/**` and `test/**` only); they run through `tsx`, which
// evaluates `import.meta` natively - so there is no CJS transform to break.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const BACKEND_PACKAGE = '@shadhil/backend';

/**
 * The backend package root, derived from THIS FILE's location
 * (`<backend>/scripts/lib/media-dir.ts` -> `<backend>`).
 *
 * Walks up looking for a `package.json` that names `@shadhil/backend`, so a
 * moved script or a repackaged layout fails loudly instead of silently
 * anchoring to the wrong directory.
 */
export function backendPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === BACKEND_PACKAGE) return dir;
      } catch {
        // Unreadable/invalid package.json - keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    [
      `Cannot locate the ${BACKEND_PACKAGE} package root above ${dirname(fileURLToPath(import.meta.url))}.`,
      'Pass an explicit absolute MEDIA_DIR to run from here.',
    ].join('\n'),
  );
}

/**
 * Absolute path to the local-disk media root.
 *
 * - `MEDIA_DIR` set: honoured as given, resolved to an absolute path (an
 *   explicit value is an operator instruction, not a default).
 * - unset: `<backend package>/media` - where the app writes when started from
 *   the backend directory, regardless of where this script was invoked from.
 */
export function resolveMediaDir(): { dir: string; source: 'env' | 'package-default' } {
  const fromEnv = process.env.MEDIA_DIR;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return { dir: resolve(fromEnv), source: 'env' };
  }
  return { dir: join(backendPackageRoot(), 'media'), source: 'package-default' };
}

/**
 * Explain where the media root is and whether it exists, so an empty scan
 * reads as "wrong directory" rather than "no data".
 */
export function describeMediaDir(): string {
  const { dir, source } = resolveMediaDir();
  const label = source === 'env' ? 'MEDIA_DIR' : 'package default';
  const line = `local disk root : ${dir}  (${label})`;
  return existsSync(dir)
    ? line
    : `${line}\n                  DOES NOT EXIST - no local blob can be found here`;
}
