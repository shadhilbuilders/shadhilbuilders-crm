// T-ORG-OWNER (2026-09-17): self-signup org creation + OWNER assignment.
//
// better-auth's `databaseHooks.user.create.after` runs with the created user
// (id known) on the bare `prisma` client - the same path credentials.ts and
// seed.ts use for auth-table writes (User/Account have no RLS policies; the
// Organization table's new `org_insert_public` INSERT policy lets the app
// role create a fresh org).
//
// When a signup carries `organizationName` (an input:true additionalField),
// we:
//   1. derive a unique org slug from the name,
//   2. create the organization with `createdBy` = the new user,
//   3. promote the user to OWNER and point `organizationId` at the new org.
//
// The creator keeps full access because the OWNER role already downcasts to
// ADMIN at the RLS layer (full org-wide authority in every policy). No other
// signup path (admin-created users, the seed) supplies `organizationName`,
// so those never create an org.
import type { PrismaClient, Role } from '@shadhil/database';

/**
 * The subset of the user the org-owner hook reads. Typed structurally (not
 * the full Prisma `User`) because the caller is better-auth's
 * `databaseHooks.user.create.after`, which passes its OWN user shape
 * (id + additionalFields like organizationName) - NOT the full Prisma row
 * (role/banned/mustChangePassword aren't set yet at user.create time).
 * The full `Prisma.User` type is a lie here and would fail tsc.
 */
export interface OrgOwnerSignupUser {
  id: string;
  organizationName?: unknown;
}

export interface OrgOwnerHookInput {
  prisma: PrismaClient;
  user: OrgOwnerSignupUser;
  /** e.g. "Acme Constructions" -> "acme-constructions" (-2 suffix on clash). */
  slugify: (name: string) => string;
}

/**
 * Create a new organization owned by `user` when the signup supplied a
 * non-empty `organizationName`. Returns the new org id, or undefined when
 * there is nothing to create (no orgName).
 */
export async function createOrgForSignup({
  prisma,
  user,
  slugify,
}: OrgOwnerHookInput): Promise<string | undefined> {
  const orgName =
    typeof user.organizationName === 'string' && user.organizationName.trim().length > 0
      ? user.organizationName.trim()
      : undefined;
  if (orgName === undefined) return undefined;

  const org = await prisma.organization.create({
    data: {
      name: orgName,
      slug: await uniqueSlug(prisma, slugify(orgName)),
      createdBy: user.id,
    },
    select: { id: true },
  });

  // Promote the creator to OWNER and bind them to the new org. The role is
  // set here (not in the user.create.before/after insert) because at `after`
  // the user's id is known and we can safely run a second update.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      role: 'OWNER' as Role,
      organizationId: org.id,
    },
  });

  return org.id;
}

/** Derive a slug unique within the Organization table (append -2, -3...). */
async function uniqueSlug(prisma: PrismaClient, base: string): Promise<string> {
  let slug = base;
  for (let n = 2; ; n++) {
    const exists = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (exists === null) return slug;
    slug = `${base}-${n}`;
  }
}
