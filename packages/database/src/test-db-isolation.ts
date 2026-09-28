// Test-only database isolation (T-TEST-DB-ISOLATION, 2026-09-16).
//
// This module is the package's SANCTIONED TEST-ONLY SURFACE, reachable as the
// `@shadhil/database/test-db-isolation` subpath export. Anything RLS-adjacent
// that only tests should do (redirecting the process at the test database,
// connecting as the bypass-RLS owner role) belongs here rather than in the
// production barrel, where it would be a loaded gun in a business-data path.
//
// WHY THIS EXISTS
// Every DB-backed suite connects through `DIRECT_DATABASE_URL` / `DATABASE_URL`
// from the repo-root `.env` - which point at the DEVELOPMENT database. Nothing
// isolated them. The visible cost was 141 project-less `Lead` rows accumulated in
// three days (raw INSERTs in test fixtures), plus dev data that no longer matched
// the canonical seed - which is why a fixture expecting `Vihaan Das` found
// `Demo Priya`.
//
// WHAT THIS DOES
// Points the test process at a SEPARATE `shadhil_crm_test` database, derived from
// the same connection details. Tests may then create, mutate and delete freely:
// the dev database is never touched.
//
// THE PART THAT MATTERS MOST: THE GUARD
// Redirecting by default would be dangerous if it ever silently *stopped*
// working - the suites would quietly write to dev again, which is the exact
// failure this exists to prevent. So it does not rely on the rewrite being
// correct. It re-reads whatever URL is in effect and THROWS unless the database
// name ends in `_test`. A misconfigured or partially-applied override fails
// loudly at import time instead of corrupting development data.
//
// Overrides are only applied when the incoming URL does NOT already look like a
// test database, so a CI-injected `DATABASE_URL` that already points at one (or
// an explicit override by a developer) always wins.
//
// TESTS DO NOT GO THROUGH PGBOUNCER. `DATABASE_URL` is the pooled path (port
// 6432), and PgBouncer's `[databases]` section lists only `shadhil_crm` - a test
// database is not routable through it ("no such database: shadhil_crm_test"). So
// each URL is rewritten in place: swap only the DATABASE NAME and, for the pooled
// URL, the PORT to the direct postgres port.
//
// THE TWO URLS USE DIFFERENT DATABASE ROLES. This is the part to get right:
//
//   DATABASE_URL        -> role `shadhil_app` - NOT the table owner, RLS ENFORCED
//   DIRECT_DATABASE_URL -> role `shadhil`     - the owner, BYPASSRLS
//
// An earlier version of this file pointed DATABASE_URL at the DIRECT url. That
// silently DISABLED RLS, because the owner role bypasses every policy - the
// security matrix then reported a clean run while enforcing nothing (a MANAGER
// could see both fixture leads instead of one). Never copy one URL over the
// other: rewrite name/port only, and let each keep its own role.
//
// NOTE: this module must NOT import `./index`. Importing the barrel CONSTRUCTS
// the pooled client at module-evaluation time, which both defeats the isolation
// below (it would connect before the rewrite runs) and breaks suites whose
// Prisma client is built after their setup file loads env. Everything here
// depends on `process.env` at CALL time instead, and the client class comes
// straight from the generated client.
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client';

/**
 * Rewrite a postgres connection URL for the test database, PRESERVING ITS ROLE.
 *
 * Appends `_test` to the database name and, when `directPostgresPort` is given,
 * moves the port to it (leaving PgBouncer, which only routes `shadhil_crm`). The
 * user/password are untouched on purpose - see the note above: the app role is
 * the one RLS is enforced against, and copying the owner URL over it would
 * disable RLS entirely.
 */
export function toTestDatabaseUrl(url: string, directPostgresPort?: string): string {
  try {
    const parsed = new URL(url);
    // pathname is '/<dbname>'; keep any query string (e.g. ?schema=public) intact.
    const name = parsed.pathname.replace(/^\//, '');
    if (name.length === 0) return url;
    parsed.pathname = `/${name}_test`;
    if (directPostgresPort !== undefined && directPostgresPort.length > 0) {
      parsed.port = directPostgresPort;
    }
    return parsed.toString();
  } catch {
    // Not a parseable URL - leave it alone; the guard below will reject it.
    return url;
  }
}

/** The port in a postgres connection URL, or '' when unparseable. */
export function portOf(url: string): string {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

/** The database name in a postgres connection URL, or '' when unparseable. */
export function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
}

/**
 * Throw unless `url` points at a database whose name ends in `_test`.
 *
 * Deliberately blunt. The cost of a false positive is a developer setting an
 * explicit name; the cost of a false negative is destroying development data.
 */
export function assertTestDatabase(url: string, envKey: string): void {
  if (process.env['TEST_DB_ALLOW_DEV'] === '1') return;
  const name = databaseNameOf(url);
  if (!name.endsWith('_test')) {
    throw new Error(
      `[test-db-isolation] ${envKey} resolves to database "${name || '<unparseable>'}", which is NOT a ` +
        `_test database. Refusing to run: DB-backed tests create and delete rows, and running them ` +
        `against the development database is how 141 orphan rows got written. ` +
        `Point it at "<dbname>_test" (run "pnpm db:test:reset" to create it).`,
    );
  }
}

/**
 * True when the override should be applied: the URL is set and is not already a
 * test database.
 *
 * `TEST_DB_ALLOW_DEV=1` disables the rewrite. That exists for the e2e job and any
 * script that genuinely needs the dev database, and it is deliberately explicit:
 * silently rewriting whatever it is handed would make "I meant the dev database"
 * indistinguishable from "isolation failed".
 */
export function shouldRedirect(url: string | undefined): url is string {
  if (url === undefined || url.length === 0) return false;
  if (process.env['TEST_DB_ALLOW_DEV'] === '1') return false;
  return !databaseNameOf(url).endsWith('_test');
}

/**
 * A Prisma client bound to `DIRECT_DATABASE_URL` (the owner role, BYPASSRLS)
 * instead of the pooled application role, for seeding tables whose RLS is
 * SELECT-only by design - most notably `ManagerAssignmentRule`, where rule
 * management is an admin-class concern and there is deliberately NO INSERT
 * policy (see prisma/rls/policies.sql). Any INSERT from the app role on such a
 * table fails with 42501, and the seed/bootstrap path already writes rules
 * through the owner role for exactly this reason.
 *
 * T-TEST-DB-ISOLATION (2026-09-28): extracted from the RLS matrix, which had
 * this construction inline, because more than one suite now needs it.
 *
 * This lives in the TEST-ONLY module on purpose. It steps outside RLS, so it
 * must not be reachable from the production barrel: import it from
 * `@shadhil/database/test-db-isolation` (the package's `./test-db-isolation`
 * subpath export), never from `@shadhil/database`. scripts/check-bare-prisma.mjs
 * enforces that in CI - app code naming this helper is a guardrail failure.
 *
 * Falls back to the pooled `DATABASE_URL` when `DIRECT_DATABASE_URL` is unset,
 * so a caller that checks for the variable can skip cleanly instead of
 * crashing. The class comes from the generated client rather than the package
 * barrel - see the NOTE above on why importing `./index` here is not an option.
 */
export function createDirectPrismaClient(): PrismaClient {
  const directUrl = process.env['DIRECT_DATABASE_URL'] ?? '';
  const url =
    directUrl !== ''
      ? directUrl
      : (process.env['DATABASE_URL'] ?? '');
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
}

/**
 * Redirect DATABASE_URL + DIRECT_DATABASE_URL at the test database and verify the
 * result. Safe to call from any suite's setup file; idempotent.
 */
export function isolateTestDatabase(): void {
  // Explicit opt-out: the caller takes responsibility for the target database.
  // Used by the e2e job, which drives the real app against a dev-shaped database
  // and must not be redirected. Both the rewrite AND the assertion are skipped,
  // otherwise opting out would immediately throw.
  if (process.env['TEST_DB_ALLOW_DEV'] === '1') return;

  const incomingDirect = process.env['DIRECT_DATABASE_URL'];
  const directIsSet = incomingDirect !== undefined && incomingDirect.length > 0;

  // The direct URL is the unpooled one; its port is the port postgres itself
  // listens on, which is where the pooled URL must be sent too.
  const directPort = directIsSet ? portOf(incomingDirect) : '';

  if (directIsSet && shouldRedirect(incomingDirect)) {
    process.env['DIRECT_DATABASE_URL'] = toTestDatabaseUrl(incomingDirect);
  }

  // Rewrite the pooled URL's NAME and PORT, but keep its own role (`shadhil_app`)
  // and credentials. Copying the direct URL here would swap in the owner role,
  // which BYPASSRLS - the matrix would pass while enforcing nothing.
  const pooled = process.env['DATABASE_URL'];
  if (shouldRedirect(pooled)) {
    process.env['DATABASE_URL'] = toTestDatabaseUrl(pooled, directPort);
  }

  // Verify whatever is now in effect - including a URL we did NOT rewrite.
  const finalDirect = process.env['DIRECT_DATABASE_URL'];
  const finalPooled = process.env['DATABASE_URL'];
  if (finalDirect !== undefined && finalDirect.length > 0) {
    assertTestDatabase(finalDirect, 'DIRECT_DATABASE_URL');
  }
  if (finalPooled !== undefined && finalPooled.length > 0) {
    assertTestDatabase(finalPooled, 'DATABASE_URL');
  }
}
