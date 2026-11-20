// RealtimeService.mintTicket - channel authorization (T-WA-INBOX, 2026-11-21).
//
// Added with the `chat-contact:<contactId>` channel. The failure this pins:
// the WhatsApp inbox minted `chat:<contactId>`, the actor passed the cuid
// check, and the backend then looked for a LEAD with that id. There is none,
// so every attempt threw 403 - and the client re-mints on each backoff retry,
// draining the per-user ticket budget (10/min) shared with `notifications`.
//
// What these tests fix:
//   1. A contact channel authorizes against WhatsappUnknownContact, NEVER Lead.
//   2. A contact the actor cannot see (RLS returns null) is refused.
//   3. A lead channel is unaffected - still a Lead lookup, no contact query.
//
// No DB: the RLS client is faked so `$transaction` simply runs the callback
// with a stub `tx`. That exercises the real branch logic (including the role
// downcast inside withRlsContext) without provisioning Postgres.
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import type { JwtPayload } from '@shadhil/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RealtimeService } from './realtime.service';

const LEAD_ID = 'ckw4v7t9b0001abcd2efghij';
const CONTACT_ID = 'ckw4v7t9b0002zzzz9yyyyyy';

function actor(): JwtPayload {
  // Full JwtPayload shape (iat/exp/iss included) - vitest transpiles without
  // type-checking, so a looser literal passed tests while `tsc` rejected it.
  return {
    sub: 'user-1',
    role: 'MANAGER',
    organizationId: 'org-1',
    email: 'm@x.test',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: 'shadhil-crm',
  };
}

/**
 * Build a service whose RLS client resolves `leadRow` / `contactRow` from the
 * fake transaction. Passing null models "RLS filtered the row out".
 */
function buildService(rows: { lead: { id: string } | null; contact: { id: string } | null }): {
  service: RealtimeService;
  leadFindUnique: ReturnType<typeof vi.fn>;
  contactFindUnique: ReturnType<typeof vi.fn>;
  ticketCreate: ReturnType<typeof vi.fn>;
} {
  const leadFindUnique = vi.fn(async () => rows.lead);
  const contactFindUnique = vi.fn(async () => rows.contact);
  const ticketCreate = vi.fn(async () => ({
    id: 'ckw4v7t9b0003ticketabcd',
    expiresAt: new Date(Date.now() + 60_000),
  }));

  const fakeTx = {
    // withRlsContext issues SET LOCAL app.* on the transaction handle before
    // calling the callback - the stub must accept them (no-op).
    $executeRawUnsafe: async () => 0,
    lead: { findUnique: leadFindUnique },
    whatsappUnknownContact: { findUnique: contactFindUnique },
  };

  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx),
    streamTicket: { create: ticketCreate },
  };

  const service = new RealtimeService({ $client: client } as never);
  return { service, leadFindUnique, contactFindUnique, ticketCreate };
}

describe('mintTicket - contact chat channel', () => {
  let rows: { lead: { id: string } | null; contact: { id: string } | null };

  beforeEach(() => {
    rows = { lead: null, contact: { id: CONTACT_ID } };
  });

  it('authorizes against the contact row, not a Lead', async () => {
    const { service, leadFindUnique, contactFindUnique, ticketCreate } = buildService(rows);

    const res = await service.mintTicket(actor(), { channel: `chat-contact:${CONTACT_ID}` });

    expect(res.channel).toBe(`chat-contact:${CONTACT_ID}`);
    expect(contactFindUnique).toHaveBeenCalledTimes(1);
    // The regression: a contact channel must never touch the Lead table.
    expect(leadFindUnique).not.toHaveBeenCalled();
    expect(ticketCreate).toHaveBeenCalledTimes(1);
  });

  it('refuses a contact the actor cannot see (RLS returned no row)', async () => {
    const { service, ticketCreate } = buildService({ lead: null, contact: null });

    await expect(
      service.mintTicket(actor(), { channel: `chat-contact:${CONTACT_ID}` }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // No ticket is minted for a refused channel - so no retry loop is funded.
    expect(ticketCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed contact id before any DB work', async () => {
    const { service, contactFindUnique } = buildService(rows);

    await expect(
      service.mintTicket(actor(), { channel: 'chat-contact:not-a-cuid' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(contactFindUnique).not.toHaveBeenCalled();
  });
});

describe('mintTicket - lead chat channel is unchanged', () => {
  it('still authorizes against the Lead row and never queries contacts', async () => {
    const { service, leadFindUnique, contactFindUnique } = buildService({
      lead: { id: LEAD_ID },
      contact: null,
    });

    const res = await service.mintTicket(actor(), { channel: `chat:${LEAD_ID}` });

    expect(res.channel).toBe(`chat:${LEAD_ID}`);
    expect(leadFindUnique).toHaveBeenCalledTimes(1);
    expect(contactFindUnique).not.toHaveBeenCalled();
  });

  it('still refuses a lead the actor cannot read', async () => {
    const { service, ticketCreate } = buildService({ lead: null, contact: null });

    await expect(
      service.mintTicket(actor(), { channel: `chat:${LEAD_ID}` }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(ticketCreate).not.toHaveBeenCalled();
  });
});
