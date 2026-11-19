// Which roles an actor may hand out, and which users they may act on.
//
// These lists mirror `assertCanCreateRole` / `assertCanChangeRole` in
// apps/backend/src/users/roles.ts. They lived inside admin/users/page.tsx, which
// meant the user-detail page could not offer a role change without a second
// copy - and a second copy of a permission table is how a UI starts promising
// something the server refuses.
import type { Role } from '@/apis/client';

/** OWNER outranks ADMIN, so only the OWNER may create another ADMIN. */
export const CREATABLE_FOR_OWNER = [
  'ADMIN',
  'MANAGER',
  'TELECALLER',
  'SALES_EXEC',
  'ENGINEER',
  'CUSTOMER',
] as const;

export const CREATABLE_FOR_ADMIN = [
  'MANAGER',
  'TELECALLER',
  'SALES_EXEC',
  'ENGINEER',
  'CUSTOMER',
] as const;

export const CREATABLE_FOR_MANAGER = ['TELECALLER', 'SALES_EXEC'] as const;

/**
 * The roles this actor may create or assign.
 *
 * ENGINEER is admin-class only (issue #7) and CUSTOMER needs a lead pointer, so
 * the role-change dialog filters CUSTOMER out of the result itself - it cannot
 * be minted by a role change, only by creating an account against a lead.
 */
export function creatableRolesFor(actorRole: Role): readonly string[] {
  if (actorRole === 'OWNER') return CREATABLE_FOR_OWNER;
  if (actorRole === 'ADMIN') return CREATABLE_FOR_ADMIN;
  return CREATABLE_FOR_MANAGER;
}
