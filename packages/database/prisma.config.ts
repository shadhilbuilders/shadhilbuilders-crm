// Prisma 7 config — replaces schema.prisma datasource url for CLI commands
// (migrate / generate / studio). The client itself constructs from
// DATABASE_URL via the pg driver adapter (see src/index.ts).
// Datasource.url is no longer allowed inside schema.prisma in v7.
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