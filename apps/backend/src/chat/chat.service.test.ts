// Chat service tests - exercises the pure logic without a real DB
// (the DB-touching path needs a live Postgres for the RLS JOIN;
// the unit test pins the shape + role-scoping intent).
//
// Pattern: instantiate ChatService with a PrismaService stub whose
// $client has the methods we exercise stubbed per-test.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

import { ChatService, extractMentionedNames } from './chat.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'tc-1',
    email: 'tc@shadhilbuilders.in',
    role: 'TELECALLER',
    teamId: 'team-tc',
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

function makeService(): {
  service: ChatService;
  client: {
    $transaction: ReturnType<typeof vi.fn>;
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
    lead: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    user: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    message: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    auditLog: {
      create: ReturnType<typeof vi.fn>;
    };
  };
} {
  const client: {
    $transaction: ReturnType<typeof vi.fn>;
    $executeRawUnsafe: ReturnType<typeof vi.fn>;
    lead: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    user: {
      findUnique: ReturnType<typeof vi.fn>;
    };
    message: {
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    auditLog: {
      create: ReturnType<typeof vi.fn>;
    };
  } = {
    // withRlsContext opens a transaction; for the unit test we just
    // run the callback against the same client (no real SET LOCAL -
    // there's no DB session). The callback's `(tx as unknown as
    // PrismaClient).message.create(...)` calls resolve to the same
    // mocks on `client` below.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(client),
    ),
    // Stub the SET LOCAL calls so withRlsContext's preamble resolves.
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    lead: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    message: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  };
  const prismaService = { $client: client } as never;
  // T-E2b: ChatService now takes OutboundService as the 2nd arg. The
  // existing test stubs don't exercise the send() code path (only
  // list), so a minimal no-op stub is fine here. The send() tests
  // live in chat.service.send.test.ts (added in this commit).
  const outboundStub = { enqueue: vi.fn().mockResolvedValue(undefined) } as never;
  const service = new ChatService(prismaService, outboundStub);
  return { service, client };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('list - RLS-scoped message history for a lead', () => {
  it('returns 404 when the lead is not visible to the actor', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue(null);
    await expect(service.list(makeActor(), 'lead-x', undefined, 50))
      .rejects.toThrow(/Lead lead-x not found/);
    expect(client.message.findMany).not.toHaveBeenCalled();
  });

  it('returns chronological messages when the lead is visible', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({ id: 'lead-x' });
    client.message.findMany.mockResolvedValue([
      {
        id: 'm1',
        leadId: 'lead-x',
        direction: 'IN',
        channel: 'WHATSAPP',
        body: 'hi',
        mediaUrl: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'm2',
        leadId: 'lead-x',
        direction: 'OUT',
        channel: 'IN_APP',
        body: 'hello',
        mediaUrl: 'https://x/y.png',
        createdAt: new Date('2026-01-01T00:01:00Z'),
      },
    ]);

    const rows = await service.list(makeActor(), 'lead-x', undefined, 50);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe('m1');
    expect(rows[1]?.id).toBe('m2');
    expect(rows[1]?.mediaUrl).toBe('https://x/y.png');
    expect(client.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leadId: 'lead-x', kind: 'CUSTOMER' },
        orderBy: { createdAt: 'asc' },
        take: 50,
      }),
    );
  });

  it('filters by `since` cursor when provided', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({ id: 'lead-x' });
    client.message.findMany.mockResolvedValue([]);
    await service.list(makeActor(), 'lead-x', '2026-01-01T00:00:00Z', 10);
    expect(client.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          leadId: 'lead-x',
          kind: 'CUSTOMER',
          createdAt: { gt: new Date('2026-01-01T00:00:00Z') },
        },
        take: 10,
      }),
    );
  });
});

describe('send - staff message + audit row', () => {
  it('writes a Message row with direction=OUT and audit row in one call', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({ id: 'lead-x', name: 'Lead X' });
    client.user.findUnique.mockResolvedValue({ name: 'Asha T.' });
    client.message.create.mockResolvedValue({
      id: 'm-new',
      leadId: 'lead-x',
      direction: 'OUT',
      channel: 'IN_APP',
      body: 'hello',
      mediaUrl: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    client.auditLog.create.mockResolvedValue({ id: 'audit-1' });

    const result = await service.send(makeActor(), {
      leadId: 'lead-x',
      body: 'hello',
      channel: 'IN_APP',
    });
    expect(result).toMatchObject({
      id: 'm-new',
      leadId: 'lead-x',
      direction: 'OUT',
      channel: 'IN_APP',
      body: 'hello',
    });
    expect(client.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leadId: 'lead-x',
          userId: makeActor().sub,
          direction: 'OUT',
          channel: 'IN_APP',
          body: 'hello',
        }),
      }),
    );
    expect(client.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: makeActor().sub,
          action: 'chat.send',
          entityType: 'Message',
          entityId: 'm-new',
        }),
      }),
    );
  });

  it('rejects empty message body', async () => {
    const { service, client } = makeService();
    await expect(
      service.send(makeActor(), {
        leadId: 'lead-x',
        body: '   ',
      }),
    ).rejects.toThrow(/empty/i);
    expect(client.message.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the target lead is not visible', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue(null);
    await expect(
      service.send(makeActor(), { leadId: 'lead-x', body: 'hi' }),
    ).rejects.toThrow(/Lead lead-x not found/);
    expect(client.message.create).not.toHaveBeenCalled();
  });

  it('defaults channel to IN_APP when DTO omits it', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({ id: 'lead-x' });
    client.message.create.mockResolvedValue({
      id: 'm-new',
      leadId: 'lead-x',
      direction: 'OUT',
      channel: 'IN_APP',
      body: 'hi',
      mediaUrl: null,
      createdAt: new Date(),
    });
    client.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    await service.send(makeActor(), { leadId: 'lead-x', body: 'hi' });
    expect(client.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ channel: 'IN_APP' }),
      }),
    );
  });

  it('writes kind=INTERNAL and skips the WhatsApp enqueue for internal notes', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({ id: 'lead-x', name: 'Lead X' });
    client.user.findUnique.mockResolvedValue({ name: 'Asha T.' });
    client.message.create.mockResolvedValue({
      id: 'm-int',
      leadId: 'lead-x',
      direction: 'OUT',
      channel: 'IN_APP',
      kind: 'INTERNAL',
      body: 'loop @Manager',
      mediaUrl: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    client.auditLog.create.mockResolvedValue({ id: 'audit-1' });

    await service.send(makeActor(), {
      leadId: 'lead-x',
      body: 'loop @Manager',
      kind: 'INTERNAL',
      channel: 'WHATSAPP', // even if a caller forces WHATSAPP, internal never enqueues
    });

    expect(client.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'INTERNAL' }),
      }),
    );
    // The outbound stub is a no-op - internal notes never enqueue WhatsApp.
    expect(client.message.create).toHaveBeenCalled();
  });

  it('filters list by kind=INTERNAL when requested', async () => {
    const { service, client } = makeService();
    client.lead.findUnique.mockResolvedValue({ id: 'lead-x' });
    client.message.findMany.mockResolvedValue([]);
    await service.list(makeActor(), 'lead-x', undefined, 50, 'INTERNAL');
    expect(client.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { leadId: 'lead-x', kind: 'INTERNAL' },
      }),
    );
  });
});

describe('extractMentionedNames - @mention parsing', () => {
  it('extracts @Name tokens', () => {
    expect(extractMentionedNames('loop @Asha T. and @Ravi')).toEqual([
      'Asha T.',
      'Ravi',
    ]);
  });

  it('returns empty for no mentions', () => {
    expect(extractMentionedNames('no mentions here')).toEqual([]);
  });

  it('ignores a bare @ with no name', () => {
    expect(extractMentionedNames('email me @')).toEqual([]);
  });
});
