// Prisma 7 config - replaces schema.prisma datasource url for CLI commands
// (migrate / generate / studio). The client itself constructs from
// DATABASE_URL via the pg driver adapter (see src/index.ts).
// Datasource.url is no longer allowed inside schema.prisma in v7.
//
// Prisma 7's CLI does NOT auto-load `.env` for prisma.config.ts -
// only the schema-side PG connection picks up `.env` automatically.
// Without an explicit loader here, `DIRECT_DATABASE_URL` arrives
// empty and Prisma fails with "Connection url is empty". `dotenv`
// ^17 is already a devDep of this package, so we load the repo-root
// `.env` by explicit absolute path (resolve relative to this file,
// not CWD - pnpm filter changes CWD to packages/database, but the
// `.env` lives at the repo root).
//
// Order matters: loadDotenv must run BEFORE defineConfig evaluates
// `process.env.DIRECT_DATABASE_URL` below.
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(__dirname, '..', '..', '.env') });

import { defineConfig } from 'prisma/config';

/**
 * Database NAME from a connection URL, or '' when the URL is unparseable.
 * Kept local: this file must stay loadable on its own (prisma/config is the only
 * import the CLI guarantees here), so it cannot pull in the package barrel that
 * owns the equivalent helper.
 */
function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\/+/, '');
  } catch {
    return '';
  }
}

/**
 * A dedicated shadow database URL derived from the main one, preserving role,
 * host, port and query params and swapping only the database name:
 * `<name>` -> `<name>_shadow`, `<name>_test` -> `<name>_shadow_test`.
 *
 * WHY THIS EXISTS
 * `prisma migrate deploy` never creates the shadow database - it only VALIDATES
 * the configured URL against the main one, and aborts when they are equal. The
 * old default (`SHADOW_DATABASE_URL ?? DIRECT_DATABASE_URL`) therefore handed
 * Prisma the main database wherever SHADOW_DATABASE_URL was unset - which is
 * every CI job (they inject DIRECT_DATABASE_URL only, and the repo-root `.env`
 * is gitignored so no local value exists on the runner). Result: all three
 * DB-backed CI jobs failed at `migrate deploy` with "The shadow database you
 * configured appears to be the same as the main database", from the first commit
 * after this key was introduced until 2026-09-30.
 *
 * An explicitly-blank SHADOW_DATABASE_URL is treated as unset rather than
 * forwarded: Prisma rejects `shadowDatabaseUrl: ''` with P1013 ("must not be an
 * empty string"), which is a worse failure than the one being fixed.
 *
 * Only `migrate dev` and `migrate diff` actually create/use the shadow database
 * (deploy and generate ignore it), and they need CREATEDB on that URL's role -
 * the `shadhil` owner has it (docker/postgres-init/00-init.sql). Set
 * SHADOW_DATABASE_URL to override with a pre-provisioned shadow database.
 */
function deriveShadowDatabaseUrl(directUrl: string): string {
  const name = databaseNameOf(directUrl);
  if (name === '') return '';

  const url = new URL(directUrl);
  const isTest = name.endsWith('_test');
  const base = isTest ? name.slice(0, -'_test'.length) : name;
  url.pathname = `/${base}_shadow${isTest ? '_test' : ''}`;
  return url.toString();
}

const directUrl = process.env.DIRECT_DATABASE_URL ?? '';
const configuredShadow = process.env.SHADOW_DATABASE_URL;
const shadowUrl =
  configuredShadow !== undefined && configuredShadow !== ''
    ? configuredShadow
    : deriveShadowDatabaseUrl(directUrl);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: directUrl,
    // T-E2b (2026-09-04), fixed 2026-09-30: shadow database for `migrate diff` /
    // `migrate dev`. Derived from the main URL (never equal to it - Prisma
    // aborts on that) unless SHADOW_DATABASE_URL names a dedicated one. See
    // deriveShadowDatabaseUrl above for the full failure it replaces.
    ...(shadowUrl !== '' ? { shadowDatabaseUrl: shadowUrl } : {}),
  },
});