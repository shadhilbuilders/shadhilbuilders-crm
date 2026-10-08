// ────────────────────────────────────────────────────────────────────────────
// @shadhil/api-types - barrel
// ────────────────────────────────────────────────────────────────────────────
// Single import surface for NestJS pipes and Next.js route handlers.
// Re-exports Prisma-generated types from @shadhil/database (when consumed
// after `pnpm db:generate`) plus all Zod DTOs for the 9 NestJS modules.
// ────────────────────────────────────────────────────────────────────────────

// Enums
export * from './enums';

// Lead state + freshness semantics (single source of truth for
// "overdue" / "new today" / terminal states - imported by BOTH the NestJS
// services and the Next views so the numbers cannot drift apart).
export * from './lead-status';
export * from './lead-state-labels';

// Per-module DTOs
export * from './auth';
export * from './leads';
export * from './projects';
export * from './visits';
export * from './chat';
export * from './bookings';
export * from './inventory';
export * from './reminders';
export * from './teams';
export * from './team-membership';
export * from './organizations';
export * from './notifications';
export * from './audit';
export * from './webhooks';
export * from './whatsapp-unknown-contacts';
export * from './feedback';
export * from './integrations';
export * from './public-leads';
export * from './dashboard';
export * from './common';
export * from './realtime';
