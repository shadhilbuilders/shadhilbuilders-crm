#!/usr/bin/env node
// Points this clone's git hooks at the committed .githooks/ directory.
//
// Runs from the root `prepare` script, so a fresh `pnpm install` is all it takes
// for a clone to become protected. git config is local scope: this never touches
// a machine's global or system config, and it fails softly outside a worktree
// (tarball installs, CI checkouts without .git, Docker builds that copy the repo).
//
// Why not husky: the hook needs prettier from node_modules anyway, which means
// `prepare` has already run, so a wrapper dependency buys nothing over the git
// setting it would write for us - and it would churn the lockfile.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const hooksRel = '.githooks';

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  }).trim();
}

try {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    process.exit(0);
  }

  // Hooks live in the working tree, not the git dir. In a linked worktree this
  // still resolves, because cwd is the worktree root.
  const hook = join(root, hooksRel, 'pre-commit');
  if (!existsSync(hook)) {
    process.exit(0);
  }

  chmodSync(hook, 0o755);

  const current = (() => {
    try {
      return git(['config', '--local', '--get', 'core.hooksPath']);
    } catch {
      return '';
    }
  })();

  if (current === hooksRel) {
    process.exit(0);
  }

  git(['config', '--local', 'core.hooksPath', hooksRel]);

  if (current) {
    console.log(`install-git-hooks: core.hooksPath was "${current}", now "${hooksRel}"`);
  } else {
    console.log(`install-git-hooks: core.hooksPath -> ${hooksRel} (pre-commit prettier gate active)`);
  }
} catch {
  // A missing git binary or an unreadable repo is not this script's problem to
  // report; it must never break `pnpm install`.
  process.exit(0);
}
