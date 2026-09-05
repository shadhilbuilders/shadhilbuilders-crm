// ────────────────────────────────────────────────────────────────────────────
// @shadhil/api-types - barrel
// ────────────────────────────────────────────────────────────────────────────
// Single import surface for NestJS pipes and Next.js route handlers.
// Re-exports Prisma-generated types from @shadhil/database (when consumed
// after `pnpm db:generate`) plus all Zod DTOs for the 9 NestJS modules.
// ────────────────────────────────────────────────────────────────────────────

// Enums
export * from './enums';

// Per-module DTOs
export * from './auth';
export * from './leads';
export * from './visits';
export * from './chat';
export * from './bookings';
export * from './reminders';
export * from './notifications';
export * from './audit';
export * from './webhooks';
export * from './whatsapp-unknown-contacts';
export * from './common';
export * from './realtime';
