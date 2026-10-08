// T-CRON-MULTITENANT (2026-10-09): run cron work once per organization.
//
// Crons used to build their RLS context from the PUBLIC_ORG_ID env var, so with
// more than one Organization only one tenant was ever served. Every cron now
// asks the database for the organization ids (cron_list_org_ids(), a narrow
// SECURITY DEFINER function) and runs each batch inside that org's own
// CRON_SERVICE context, so RLS and the stamped organizationId always agree with
// the rows being touched.
import { Logger } from '@nestjs/common';
import { withRlsContext, type PrismaClient } from '@shadhil/database';

/** The cron service account. Both fields must match the RLS impersonation guard. */
export const CRON_USER_ID = 'cron-service';

/** Placeholder org used ONLY to call cron_list_org_ids() (it ignores the org GUC). */
const LIST_ORGS_CONTEXT_ORG = '__cron_list__';

export type CronContext = {
  userId: typeof CRON_USER_ID;
  role: 'CRON_SERVICE';
  organizationId: string;
};

/** RLS context for the cron service account inside one organization. */
export function cronContextFor(organizationId: string): CronContext {
  if (organizationId.length === 0) {
    throw new Error('cronContextFor: organizationId is required');
  }
  return { userId: CRON_USER_ID, role: 'CRON_SERVICE', organizationId };
}

/** Ids of every organization. Throws on failure - a cron must not silently serve nobody. */
export async function listOrganizationIds(client: PrismaClient): Promise<string[]> {
  const rows = await withRlsContext(
    client,
    { userId: CRON_USER_ID, role: 'CRON_SERVICE', organizationId: LIST_ORGS_CONTEXT_ORG },
    (tx) =>
      (tx as unknown as PrismaClient).$queryRaw<Array<{ cron_list_org_ids: string }>>`
        SELECT cron_list_org_ids() AS cron_list_org_ids
      `,
  );
  return rows.map((r) => r.cron_list_org_ids);
}

/**
 * Run `fn` for each organization, sequentially. One organization failing is
 * logged with its id and does not stop the others (a bad tenant must not starve
 * the rest); the number of failures is returned so callers can surface it.
 */
export async function forEachOrganization(
  client: PrismaClient,
  logger: Logger,
  label: string,
  fn: (ctx: CronContext, organizationId: string) => Promise<void>,
): Promise<{ organizations: number; failed: number }> {
  const orgIds = await listOrganizationIds(client);
  let failed = 0;
  for (const organizationId of orgIds) {
    try {
      await fn(cronContextFor(organizationId), organizationId);
    } catch (err) {
      failed += 1;
      logger.error(
        `${label} failed for organization ${organizationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { organizations: orgIds.length, failed };
}
