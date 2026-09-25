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
//   1. Pre-flight: skips (with a clear message) if ZOMBIE tsc-watch
//      processes are detected, because in that state the build IS
//      expected to fail. The fix is `pkill -f 'tsc.*--watch'` or
//      reattaching to the dev shell and Ctrl-C'ing the watch.
//
//      A zombie is an ORPHANED watch (its launching `pnpm dev` is gone).
//      A watch that is a live child of a running `pnpm run dev` is the
//      NORMAL dev state, not a fault: killing it breaks the developer's
//      server, and `clean` + rebuild is exactly what that watch is meant
//      to survive. Earlier revisions matched on the command line alone,
//      so a running `pnpm dev` made this test fail spuriously. See
//      isZombieWatch() below.
//   2. Runs the full prebuild chain sequence (clean all 3 + build all 3)
//      via execSync from the repo root, exactly as `pnpm --filter
//      @shadhil/web build` invokes it.
//   3. Asserts that auth-client/dist/ contains all 6 .js files.
//
// The package's own `clean` script (`rm -rf dist tsconfig.build.tsbuildinfo`)
// is correct on its own - the test verifies the END-TO-END behaviour
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

/** pid -> parent pid, for every live process. */
function processTable(): Map<number, number> {
  const parents = new Map<number, number>();
  try {
    const out = run('ps -eo pid,ppid', '/tmp');
    for (const line of out.split('\n').slice(1)) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid, ppid);
    }
  } catch {
    /* no ps -> treat as no processes known */
  }
  return parents;
}

/** True when a live ancestor is a `pnpm ... dev` process, i.e. the watch
 *  belongs to a developer's running dev server rather than being leaked. */
function hasLiveDevAncestor(pid: number, parents: Map<number, number>): boolean {
  let current = parents.get(pid);
  const seen = new Set<number>([pid]);
  while (current !== undefined && current > 1 && !seen.has(current)) {
    seen.add(current);
    let args = '';
    try {
      args = run(`ps -o args= -p ${current}`, '/tmp');
    } catch {
      return false; // ancestor vanished mid-walk -> not a live dev ancestor
    }
    if (/pnpm(\s|$)[^\n]*\bdev\b/.test(args)) return true;
    current = parents.get(current);
  }
  return false;
}

/** All tsc-watch processes, partitioned into leaked vs dev-owned. */
function classifyWatchProcesses(): {
  leaked: string[];
  devOwned: string[];
} {
  const leaked: string[] = [];
  const devOwned: string[] = [];
  try {
    const parents = processTable();
    const out = run('ps -eo pid=,args=', '/tmp');
    for (const line of out.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const args = match[2];
      if (!/tsc.*tsconfig\.build\.json.*--watch/.test(args)) continue;
      (hasLiveDevAncestor(pid, parents) ? devOwned : leaked).push(
        line.trim(),
      );
    }
  } catch {
    /* no ps -> nothing known */
  }
  return { leaked, devOwned };
}

describe('@shadhil/auth - prebuild chain emits all source files', () => {
  let leaked: string[];
  let devOwned: string[];
  // Only true once the destructive body (clean + rebuild) has actually run.
  // afterAll must NOT delete dist/ on a skipped run: dist/ is what a running
  // dev server serves, and wiping it there is the very outage this test is
  // supposed to prevent.
  let ranBuildChain = false;

  beforeAll(() => {
    ({ leaked, devOwned } = classifyWatchProcesses());
  });

  afterAll(() => {
    // Nothing to undo when the destructive body never ran.
    if (!ranBuildChain) return;
    // Leave the package in the same state we found it. The prebuild
    // chain leaves dist/ populated (database/auth/api-types all have
    // fresh dists); we just need to not leak stale tsbuildinfo or
    // dist into the next test.
    if (existsSync(DIST_DIR)) rmSync(DIST_DIR, { recursive: true });
    const buildinfo = join(PKG_DIR, 'tsconfig.build.tsbuildinfo');
    if (existsSync(buildinfo)) rmSync(buildinfo);
  });

  it('emits all 6 source .js files to dist/ after the prebuild chain', (ctx) => {
    if (leaked.length > 0) {
      // Don't fail the test - fail the OPERATOR. The build is correctly
      // expected to fail in this state. Surface the issue clearly.
      throw new Error(
        `Leaked tsc --watch process(es) detected (${leaked.length}) -\n` +
          `no live \`pnpm dev\` owns them. Their in-memory tsbuildinfo\n` +
          `will outlive the prebuild's clean step and leave dist/\n` +
          `broken. Fix:\n` +
          `  pkill -f 'tsc.*tsconfig.build.json.*--watch'\n\n` +
          leaked.join('\n'),
      );
    }

    if (devOwned.length > 0) {
      // A running dev server owns these watches. That is a normal state,
      // NOT a fault - but this test is DESTRUCTIVE (it cleans and
      // rebuilds the very dists the dev server is serving, then removes
      // auth-client/dist in afterAll). Running it here would disrupt the
      // developer's session for no benefit, so skip rather than fail.
      // Run this test with `pnpm dev` stopped to get real coverage.
      ctx.skip(
        `Skipped: a live \`pnpm dev\` owns ${devOwned.length} tsc --watch\n` +
          `process(es). This test cleans + rebuilds their dists, so it\n` +
          `cannot run safely alongside a dev server. Stop \`pnpm dev\`\n` +
          `and re-run for real coverage.\n\n` +
          devOwned.join('\n'),
      );
      return;
    }

    ranBuildChain = true;

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
