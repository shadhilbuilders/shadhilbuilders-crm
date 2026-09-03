// Build-emit regression test for @shadhil/auth.
//
// Pins the expected behaviour: after the apps/web prebuild chain runs
// `clean` on @shadhil/database, @shadhil/auth, @shadhil/api-types, then
// builds each, the auth-client package's dist/ must contain all 6
// emitted .js files (one per src/*.ts: auth, auth-client, env, index,
// jwt, types).
//
// Failure mode this guards against (root-caused 2026-09-03):
//   When a `tsc -p tsconfig.build.json --watch` process is left running
//   in the background (zombie from a prior `pnpm dev`), it holds the
//   tsconfig.build.tsbuildinfo in memory. The prebuild's `clean` script
//   removes the on-disk tsbuildinfo, but the watch process re-writes
//   its stale in-memory state. The next `pnpm run build` then reads the
//   stale tsbuildinfo and emits only the subset of source files the
//   watch process had in its graph (reproducibly: just auth.js, missing
//   the other 5). Downstream `next build` then fails with:
//     Module not found: Can't resolve '@shadhil/auth/auth-client'
//
// This test:
//   1. Pre-flight: skips (with a clear message) if zombie tsc-watch
//      processes are detected, because in that state the build IS
//      expected to fail. The fix is `pkill -f 'tsc.*--watch'` or
//      reattaching to the dev shell and Ctrl-C'ing the watch.
//   2. Runs the full prebuild chain sequence (clean all 3 + build all 3)
//      via execSync from the repo root, exactly as `pnpm --filter
//      @shadhil/web build` invokes it.
//   3. Asserts that auth-client/dist/ contains all 6 .js files.
//
// The package's own `clean` script (`rm -rf dist tsconfig.build.tsbuildinfo`)
// is correct on its own — the test verifies the END-TO-END behaviour
// through the prebuild chain.
//
// Reference: discovered while integrating landing-page brand assets
// into the CRM web app (commit 2026-09-03 in conversation log).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(new URL('..', import.meta.url).pathname, '..', '..');
const PKG_DIR = join(REPO_ROOT, 'packages', 'auth-client');
const DIST_DIR = join(PKG_DIR, 'dist');

// All 6 source files in src/ that should be emitted to dist/.
// Matches the `exports` map subpaths: "." (auth, env, index, jwt, types)
// and "./auth-client" (auth-client).
const EXPECTED_JS = [
  'auth-client.js',
  'auth.js',
  'env.js',
  'index.js',
  'jwt.js',
  'types.js',
];

function run(cmd: string, cwd: string = REPO_ROOT): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function countZombieWatchProcesses(): string[] {
  try {
    const out = run('ps -eo pid,comm,args', '/tmp');
    return out
      .split('\n')
      .filter((line) => /tsc.*tsconfig\.build\.json.*--watch/.test(line))
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

describe('@shadhil/auth — prebuild chain emits all source files', () => {
  let zombies: string[];

  beforeAll(() => {
    zombies = countZombieWatchProcesses();
  });

  afterAll(() => {
    // Leave the package in the same state we found it. The prebuild
    // chain leaves dist/ populated (database/auth/api-types all have
    // fresh dists); we just need to not leak stale tsbuildinfo or
    // dist into the next test.
    if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true });
    const buildinfo = join(PKG_DIR, 'tsconfig.build.tsbuildinfo');
    if (existsSync(buildinfo)) rmSync(buildinfo);
  });

  it('emits all 6 source .js files to dist/ after the prebuild chain', () => {
    if (zombies.length > 0) {
      // Don't fail the test — fail the OPERATOR. The build is correctly
      // expected to fail in this state. Surface the issue clearly.
      throw new Error(
        `Zombie tsc --watch process(es) detected (${zombies.length}).\n` +
          `The prebuild chain's clean step is racing with these watch\n` +
          `processes and will leave dist/ in a broken state. Fix:\n` +
          `  pkill -f 'tsc.*tsconfig.build.json.*--watch'\n` +
          `or reattach to the dev shell and Ctrl-C the watch.\n\n` +
          zombies.join('\n'),
      );
    }

    // Step 1: clean all 3 packages (the exact prebuild invocation).
    run(
      'pnpm -r --filter @shadhil/database --filter @shadhil/auth --filter @shadhil/api-types run clean',
    );

    // Step 2: build database FIRST so its dist/ exists for auth-client
    // to require() (auth.ts imports from @shadhil/database).
    run('pnpm --filter @shadhil/database build');

    // Step 3: build auth-client. After this, all 6 source .js files
    // must be in dist/. If only `auth.js` is present, the bug
    // described at the top of this file is back.
    run('pnpm --filter @shadhil/auth build');

    // Step 4: build api-types (for parity with the real prebuild).
    run('pnpm --filter @shadhil/api-types build');

    const emittedJs = readdirSync(DIST_DIR)
      .filter((f) => f.endsWith('.js'))
      .sort();

    for (const expected of EXPECTED_JS) {
      expect(
        emittedJs,
        `dist/ is missing ${expected} after prebuild. Emitted: ${emittedJs.join(', ')}`,
      ).toContain(expected);
    }
  }, 120_000);
});
