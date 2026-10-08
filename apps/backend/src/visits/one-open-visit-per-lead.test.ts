// T-VISIT-LEAD-SYNC (2026-10-09): the database itself refuses a second open visit
// on one lead (partial unique index SiteVisit_one_open_per_lead), so duplicate
// rows in Today's visits cannot come back through ANY writer.
import { describe, expect, it } from 'vitest';
import { prisma as runtimePrisma, withRlsContext } from '@shadhil/database';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const ctx = { userId: 'oov-admin', role: 'ADMIN' as const, organizationId: ORG };

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)('SiteVisit one-open-per-lead index', () => {
  it('rejects a second SCHEDULED row for the same lead but allows closed ones', async () => {
    const lead = await withRlsContext(runtimePrisma, ctx, (db) =>
      db.lead.findFirst({
        where: { organizationId: ORG },
        select: { id: true, organizationId: true, ownerId: true },
      }),
    );
    if (lead === null) throw new Error('fixture: test DB has no lead to attach visits to');
    const RUN = Date.now();
    const base = {
      leadId: lead.id,
      organizationId: lead.organizationId,
      userId: lead.ownerId,
      scheduledFor: new Date(Date.now() + 86_400_000),
    };
    const ROLLBACK = new Error('rollback');

    const outcome = await withRlsContext(runtimePrisma, ctx, async (tx) => {
      // Park any pre-existing open row so the assertion is about OUR rows only.
      await tx.siteVisit.updateMany({
        where: { leadId: lead.id, status: 'SCHEDULED' },
        data: { status: 'CANCELLED' },
      });
      await tx.siteVisit.create({ data: { id: `oov-a-${RUN}`, ...base, status: 'SCHEDULED' } });
      // Closed rows are unlimited.
      await tx.siteVisit.create({ data: { id: `oov-c-${RUN}`, ...base, status: 'COMPLETED' } });
      await tx.siteVisit.create({ data: { id: `oov-r-${RUN}`, ...base, status: 'RESCHEDULED' } });

      // A failed statement aborts a Postgres transaction, so run the violating
      // insert in a savepoint-free way: capture and then roll everything back.
      let violation: unknown = null;
      try {
        await tx.siteVisit.create({ data: { id: `oov-b-${RUN}`, ...base, status: 'SCHEDULED' } });
      } catch (error) {
        violation = error;
      }
      throw Object.assign(ROLLBACK, { violation });
    }).catch((error: unknown) => error);

    expect(outcome).toBe(ROLLBACK);
    const violation = (outcome as { violation: { code?: string; message?: string } | null })
      .violation;
    expect(violation).not.toBeNull();
    expect(`${violation?.code ?? ''} ${violation?.message ?? ''}`).toMatch(
      /P2002|one_open_per_lead|unique/i,
    );
  });
});
