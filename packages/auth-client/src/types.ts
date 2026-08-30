// Inferred types from better-auth — single source of truth for session shape.
import type { auth } from './auth';

export type Auth = typeof auth;
export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = typeof auth.$Infer.Session.user;
