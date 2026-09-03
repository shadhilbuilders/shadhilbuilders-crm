// Prisma 7 config — replaces schema.prisma datasource url for CLI commands
// (migrate / generate / studio). The client itself constructs from
// DATABASE_URL via the pg driver adapter (see src/index.ts).
// Datasource.url is no longer allowed inside schema.prisma in v7.
//
// Prisma 7's CLI does NOT auto-load `.env` for prisma.config.ts —
// only the schema-side PG connection picks up `.env` automatically.
// Without an explicit loader here, `DIRECT_DATABASE_URL` arrives
// empty and Prisma fails with "Connection url is empty". `dotenv`
// ^17 is already a devDep of this package, so we load the repo-root
// `.env` by explicit absolute path (resolve relative to this file,
// not CWD — pnpm filter changes CWD to packages/database, but the
// `.env` lives at the repo root).
//
// Order matters: loadDotenv must run BEFORE defineConfig evaluates
// `process.env.DIRECT_DATABASE_URL` below.
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv({ path: resolve(__dirname, '..', '..', '.env') });

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DIRECT_DATABASE_URL ?? '',
  },
});