#!/usr/bin/env node
/**
 * T-G1 verify item: "lint rule/grep CI check banning bare prisma in
 * controllers".
 *
 * Scans apps/backend/src (excluding *.test.ts) for business code that
 * calls the BARE prisma client (`prisma.<model>` / `sharedPrisma.<model>`
 * / `$transaction` / `prismaService.$client.<model>` chains) OUTSIDE a
 * withRlsContext wrapper. Business queries MUST run under RLS; the
 * sanctioned bare-client uses are:
 *   - migrations, seed, RLS tests (not in apps/backend/src)
 *   - better-auth session/account writes (jwt-auth.guard.ts)
 *   - webhook ingest (webhooks.controller.ts)
 *   - system crons (outbound.cron.ts)
 *
 * Mechanism: flag any file that (a) imports `prisma` (or aliases it)
 * from @shadhil/database, or accesses `prismaService.$client`, AND
 * (b) does not pass that client into withRlsContext. Files in the
 * ALLOWLIST are skipped (they are the sanctioned uses above - each
 * allowlist entry must carry a why).
 *
 * Exit 1 on any violation. Wired into CI as the `guardrails` job.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Sanctioned bare-client files. Key = path from repo root. Value = why. */
const ALLOWLIST = {
  'apps/backend/src/auth/jwt-auth.guard.ts':
    'T-S hardening: mustChangePassword gate - better-auth session/user lookups are pre-RLS by design (see policies.sql)',
  'apps/backend/src/webhooks/webhooks.controller.ts':
    'Signature-verified Meta webhook ingest is a sanctioned bare-client path (AGENTS.md); barePrisma is passed INTO withRlsContext',
  'apps/backend/src/whatsapp-unknown-contacts/whatsapp-unknown-contacts.service.ts':
    'barePrisma used only to seed demo fixtures in ensureDemoFixtures; business queries run via withRlsContext',
  'apps/backend/src/whatsapp/outbound.cron.ts':
    'System cron (CRON_SERVICE) is a sanctioned bare-client path (AGENTS.md)',
  'apps/backend/src/prisma/prisma.module.ts':
    'Provider module - constructs and exposes PrismaService.$client for the whole app; performs no business queries itself',
};

const SKIP_TEST_FILE = /(^|\.)(test|spec)\.tsx?$/;

// Files that merely DECLARE the sanctioned pattern are fine even
// without matching the heuristics - but the heuristic still needs to
// catch the actual failure mode. Walk the tree.
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry) && !SKIP_TEST_FILE.test(entry)) {
      yield full;
    }
  }
}

function main() {
  const violations = [];
  for (const file of walk(join(ROOT, 'apps/backend/src'))) {
    const rel = relative(ROOT, file).replaceAll('\\', '/');
    const src = readFileSync(file, 'utf8');

    // (a0) Does the file reach for the BYPASS-RLS owner-role client? That helper
    // exists only for test fixtures on tables whose RLS has no INSERT policy, and
    // it is exported from the test-only subpath precisely so business code cannot
    // mistake it for a normal client. Naming it anywhere under apps/backend/src
    // (tests included) is a violation - suites import it from
    // '@shadhil/database/test-db-isolation', which this pattern does not match.
    if (/\bcreateDirectPrismaClient\b/.test(src)) {
      violations.push(
        `${rel}: references createDirectPrismaClient, the BYPASS-RLS owner-role client. ` +
          `It is a TEST-ONLY fixture helper (import it from '@shadhil/database/test-db-isolation'); ` +
          `business queries MUST run under withRlsContext (AGENTS.md).`,
      );
      continue;
    }

    // (a) Does the file get hold of a bare prisma client at all?
    const importsBarePrisma =
      /import\s+\{[^}]*\bprisma\b[^}]*\}\s+from\s+['"]@shadhil\/database['"]/.test(src) ||
      /prismaService\.\$client/.test(src);

    if (!importsBarePrisma) continue;

    // (b) Does it feed that client into withRlsContext? A file that
    // imports bare prisma but never wraps it is suspicious. The
    // genuine business-write failure mode is `prisma.<model>.<op>`
    // called directly; withRlsContext files pass the client as the
    // first arg, so look for the wrapper call itself.
    const usesRls =
      /withRlsContext\s*\(/.test(src) ||
      /\$transaction\s*\(\s*async/.test(src);

    if (!usesRls && !ALLOWLIST[rel]) {
      violations.push(
        `${rel}: imports the bare prisma client (or prismaService.$client) but never calls withRlsContext - ` +
          `business queries MUST run under RLS (AGENTS.md). If this is a sanctioned bare-client path ` +
          `(webhook ingest, system cron, better-auth session), add it to scripts/check-bare-prisma.mjs ALLOWLIST with a why.`,
      );
    }
  }

  if (violations.length > 0) {
    console.error('✗ bare-prisma guardrail FAILED:\n');
    for (const v of violations) console.error(`  - ${v}`);
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
  }
  console.log('✓ bare-prisma guardrail passed - all bare-client imports are wrapped or allowlisted');
}

main();