// T-LEAD-FACTS (2026-11-05): the landing-form enquiry is the first producer of
// a lead fact.
//
// These are wiring tests, not policy tests: the policy (what a band means, what
// may be overwritten) lives in lead-evidence.ts / lead-facts.rules.ts and is
// covered there. What matters here is that the enquiry's address reaches the
// ledger instead of the column, that it carries the right evidence kind, and
// that an enquiry with no address records nothing at all.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PublicLeadsService } from './public-leads.service';

const ORG = 'ceid01lpfe1esm8jwsxid41k28';
const PROJECT = 'ydrwwx6zzyg7qnb7a9toe5bz';
const OWNER = 'wwj8bwawdwawkr0917f0z57u';

type Recorded = { leadId: string; dto: Record<string, unknown> };

function harness(
  options: {
    recordedApplies?: boolean;
    createdLead?: { id: string };
  } = {},
) {
  const recorded: Recorded[] = [];

  const tx = {
    $executeRawUnsafe: async () => 1,
    organization: { findUnique: async () => ({ id: ORG }) },
    project: { findFirst: async () => ({ id: PROJECT }) },
    user: { findFirst: async () => ({ id: OWNER }) },
  };

  const prisma = {
    $client: { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) },
  };

  const createInTransaction = vi.fn(async (_actor: unknown, dto: unknown) => ({
    id: options.createdLead?.id ?? 'lead-new',
    name: 'Ramesh',
    phone: '9876543210',
    phoneE164: '919876543210',
    state: 'NEW',
    source: 'LANDING',
    ownerId: OWNER,
    ownerName: null,
    teamId: 'team-1',
    ...(dto as object),
  }));

  const recordInTransaction = vi.fn(
    async (_actor: unknown, leadId: string, dto: Record<string, unknown>) => {
      recorded.push({ leadId, dto });
      const applies = options.recordedApplies ?? true;
      return {
        stored: applies,
        applied: applies,
        band: applies ? 'VERIFIED' : null,
        score: applies ? 0.9 : 0,
        rationale: 'probe',
        reason: applies ? undefined : 'below the floor',
      };
    },
  );

  const service = new PublicLeadsService(
    { createInTransaction } as never,
    { recordInTransaction } as never,
    prisma as never,
  );

  return { service, recorded, createInTransaction, recordInTransaction };
}

describe('PublicLeadsService - the landing enquiry produces an email fact', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = {
      ...env,
      PUBLIC_ORG_ID: ORG,
      LEADS_FALLBACK_PROJECT_ID: PROJECT,
      LEADS_FALLBACK_OWNER_ID: OWNER,
    };
  });

  afterEach(() => {
    process.env = env;
  });

  it('creates the lead WITHOUT the email, then records it through the ledger', async () => {
    const { service, createInTransaction, recorded } = harness();

    const result = await service.createLead({
      fullName: 'Ramesh Kumar',
      phone: '9876543210',
      email: 'ramesh@example.com',
    } as never);

    // The column is the ledger's job now, so the create DTO must not carry it.
    const dto = createInTransaction.mock.calls[0]?.[1] as { email?: string };
    expect(dto.email).toBeUndefined();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.leadId).toBe('lead-new');
    expect(recorded[0]?.dto).toMatchObject({
      field: 'email',
      value: 'ramesh@example.com',
      method: 'public-enquiry',
    });
    expect(recorded[0]?.dto['evidence']).toEqual([
      {
        kind: 'enquiry.form-email',
        detail: 'the enquiry carried this address',
      },
    ]);

    expect(result).toEqual({ ok: true, id: 'lead-new', state: 'NEW' });
  });

  it('records nothing when the enquiry carried no address', async () => {
    const { service, recorded } = harness();

    await service.createLead({
      fullName: 'Ramesh Kumar',
      phone: '9876543210',
    } as never);

    expect(recorded).toHaveLength(0);
  });

  it('still returns the lead when the ledger refuses, and says so in the log', async () => {
    const { service } = harness({ recordedApplies: false });
    const error = vi
      .spyOn((service as unknown as { logger: { error: () => void } }).logger, 'error')
      .mockImplementation(() => undefined);

    const result = await service.createLead({
      fullName: 'Ramesh Kumar',
      phone: '9876543210',
      email: 'ramesh@example.com',
    } as never);

    // A refused VERIFIED fill would be a bug, not a policy outcome: the lead
    // must still exist, and the refusal must be visible in the log rather than
    // swallowed.
    expect(result.ok).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('email fact NOT applied'));
  });
});

// T-LEAD-SOURCES (2026-11-05): the endpoint is no longer landing-only. Every
// channel an ad platform or a portal sends must reach the lead as ONE canonical
// token, because the manager-assignment engine matches Lead.source exactly.
describe('PublicLeadsService - inbound channels other than the landing page', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = {
      ...env,
      PUBLIC_ORG_ID: ORG,
      LEADS_FALLBACK_PROJECT_ID: PROJECT,
      LEADS_FALLBACK_OWNER_ID: OWNER,
    };
  });

  afterEach(() => {
    process.env = env;
  });

  async function sourceOf(raw: string | undefined): Promise<string> {
    const { service, createInTransaction } = harness();
    await service.createLead({
      fullName: 'Ramesh Kumar',
      phone: '9876543210',
      ...(raw === undefined ? {} : { source: raw }),
    } as never);
    const dto = createInTransaction.mock.calls[0]?.[1] as { source: string };
    return dto.source;
  }

  it('keeps the landing page working with no channel at all', async () => {
    expect(await sourceOf(undefined)).toBe('LANDING');
  });

  it('stores a Facebook or Instagram enquiry as META_AD', async () => {
    expect(await sourceOf('facebook')).toBe('META_AD');
    expect(await sourceOf('instagram')).toBe('META_AD');
    expect(await sourceOf('ig')).toBe('META_AD');
  });

  it('stores a portal enquiry on its canonical token', async () => {
    expect(await sourceOf('housing.com')).toBe('HOUSING');
    expect(await sourceOf('magicbricks')).toBe('MAGICBRICKS');
    expect(await sourceOf('99acres')).toBe('99ACRES');
  });

  it('records an unknown channel as OTHER instead of dropping the lead', async () => {
    expect(await sourceOf('some-new-portal-2027')).toBe('OTHER');
  });
});
