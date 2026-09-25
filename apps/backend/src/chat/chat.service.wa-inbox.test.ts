// WhatsApp inbox (T-WA-INBOX) - service-layer tests.
//
// These exercise ChatService.conversations / listContact / sendToContact /
// markRead plus the query DTO coercion. The DB-touching paths run against the
// Prisma stub, so what is pinned here is the CONTRACT: which SQL params go out,
// how rows map to the wire shape, the 404/403 gates, and the transaction.
//
// The RLS isolation itself is proven separately (against a live Postgres as the
// non-superuser role) - a stub cannot prove a policy.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@shadhil/auth';

import { ChatService } from './chat.service';

function makeActor(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'mgr-1',
    email: 'mgr@shadhilbuilders.in',
    role: 'MANAGER',
    organizationId: 'ceid01lpfe1esm8jwsxid41k28',
    iat: 0,
    exp: 0,
    iss: 'shadhil-crm',
    ...overrides,
  };
}

function makeService() {
  const client = {
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    lead: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    message: { findMany: vi.fn(), create: vi.fn() },
    whatsappUnknownContact: { findUnique: vi.fn() },
    chatReadState: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const prismaService = { $client: client } as never;
  const outboundStub = { enqueue: vi.fn().mockResolvedValue(undefined) } as never;
  const service = new ChatService(prismaService, outboundStub);
  return { service, client, outbound: outboundStub as unknown as { enqueue: ReturnType<typeof vi.fn> } };
}

/** A raw conversation row shaped exactly like the SQL returns it. */
function rawThreadRow(overrides: Record<string, unknown> = {}) {
  return {
    thread_kind: 'LEAD',
    thread_id: 'lead-1',
    display_name: 'Asha Menon',
    phone_e164: '919000000111',
    linked_lead_id: 'lead-1',
    project_name: 'Shadhil Metro Heights',
    last_message_body: 'any updates?',
    last_message_direction: 'IN',
    last_message_at: new Date('2026-09-25T10:00:00Z'),
    last_inbound_at: new Date('2026-09-25T09:55:00Z'),
    unread_count: 3n,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conversations - the WhatsApp inbox list', () => {
  it('maps a raw union row onto the wire shape (bigint unread -> number)', async () => {
    const { service, client } = makeService();
    // 1st $queryRawUnsafe = threads, 2nd = unread total, 3rd = thread count.
    client.$queryRawUnsafe
      .mockResolvedValueOnce([rawThreadRow()])
      .mockResolvedValueOnce([{ total_unread: 7n }])
      .mockResolvedValueOnce([{ cnt: 1n }]);

    const result = await service.conversations(makeActor(), {
      limit: 50,
      offset: 0,
    });

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row).toMatchObject({
      threadKind: 'LEAD',
      threadId: 'lead-1',
      threadKey: 'LEAD:lead-1',
      displayName: 'Asha Menon',
      phoneE164: '919000000111',
      unreadCount: 3,
    });
    // Timestamps must be ISO strings on the wire, not Date objects.
    expect(row.lastMessageAt).toBe('2026-09-25T10:00:00.000Z');
    expect(row.lastInboundAt).toBe('2026-09-25T09:55:00.000Z');
    expect(typeof row.unreadCount).toBe('number');
    // A thread count (not a message count) and the org-wide unread total.
    expect(result.total).toBe(1);
    expect(result.totalUnread).toBe(7);
  });

  it('treats a CONTACT thread as CONTACT and derives threadKey from it', async () => {
    const { service, client } = makeService();
    client.$queryRawUnsafe
      .mockResolvedValueOnce([
        rawThreadRow({
          thread_kind: 'CONTACT',
          thread_id: 'contact-9',
          display_name: '919000000999',
          phone_e164: '919000000999',
          linked_lead_id: null,
          project_name: null,
          last_inbound_at: null,
        }),
      ])
      .mockResolvedValueOnce([{ total_unread: 0n }])
      .mockResolvedValueOnce([{ cnt: 1n }]);

    const result = await service.conversations(makeActor(), { limit: 50, offset: 0 });
    expect(result.rows[0]).toMatchObject({
      threadKind: 'CONTACT',
      threadKey: 'CONTACT:contact-9',
      linkedLeadId: null,
      projectName: null,
      // null inbound is meaningful: the composer reads it as "window closed".
      lastInboundAt: null,
    });
  });

  it('maps a last message sent by staff to direction OUT (the list shows "You: ...")', async () => {
    const { service, client } = makeService();
    client.$queryRawUnsafe
      .mockResolvedValueOnce([
        rawThreadRow({ last_message_direction: 'OUT', last_message_body: 'on our way' }),
      ])
      .mockResolvedValueOnce([{ total_unread: 0n }])
      .mockResolvedValueOnce([{ cnt: 1n }]);

    const result = await service.conversations(makeActor(), { limit: 50, offset: 0 });
    // The list pane prefixes our own last message with "You:" - which only
    // happens when this survives as OUT rather than being flattened to IN.
    expect(result.rows[0]!.lastMessageDirection).toBe('OUT');
  });

  it('passes the actor id as $1 so unread is per-user, and forwards search/kind/paging', async () => {
    const { service, client } = makeService();
    client.$queryRawUnsafe.mockResolvedValue([]);

    await service.conversations(makeActor({ sub: 'mgr-42' }), {
      search: 'asha',
      kind: 'LEAD',
      unreadOnly: true,
      limit: 10,
      offset: 20,
    });

    const firstCall = client.$queryRawUnsafe.mock.calls[0]!;
    const params = firstCall.slice(1);
    // $1 = the requesting user (per-user read state), then $2..$6.
    expect(params[0]).toBe('mgr-42');
    expect(params[1]).toBe('%asha%');
    expect(params[2]).toBe('LEAD');
    expect(params[3]).toBe(true);
    expect(params[4]).toBe(10);
    expect(params[5]).toBe(20);
  });

  it('omits the search pattern (null) when no search is given', async () => {
    const { service, client } = makeService();
    client.$queryRawUnsafe.mockResolvedValue([]);
    await service.conversations(makeActor(), { limit: 50, offset: 0 });
    expect(client.$queryRawUnsafe.mock.calls[0]![2]).toBeNull();
  });
});

describe('listContact - message history on a contact thread', () => {
  it('404s when the contact is not visible', async () => {
    const { service, client } = makeService();
    client.whatsappUnknownContact.findUnique.mockResolvedValue(null);
    await expect(service.listContact(makeActor(), 'contact-x', 50)).rejects.toThrow(
      /contact-x not found/,
    );
    expect(client.message.findMany).not.toHaveBeenCalled();
  });

  it('scopes the query by contactId and never by leadId', async () => {
    const { service, client } = makeService();
    // Called twice: the visibility check, then the sender-name resolution.
    client.whatsappUnknownContact.findUnique.mockResolvedValue({
      id: 'contact-1',
      phoneE164: '919000000999',
      convertedToLeadId: null,
    });
    client.message.findMany.mockResolvedValue([]);

    await service.listContact(makeActor(), 'contact-1', 25);

    const args = client.message.findMany.mock.calls[0]![0]!;
    expect(args.where).toEqual({ contactId: 'contact-1' });
    expect(args.where).not.toHaveProperty('leadId');
    expect(args.take).toBe(25);
    expect(args.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('names the sender by lead name when the number is linked, else by phone', async () => {
    const { service, client } = makeService();
    const base = {
      id: 'm1',
      leadId: null,
      contactId: 'contact-1',
      direction: 'IN',
      channel: 'WHATSAPP',
      kind: 'CUSTOMER',
      body: 'hello',
      mediaUrl: null,
      mediaKey: null,
      mediaType: null,
      mediaFilename: null,
      createdAt: new Date('2026-09-25T10:00:00Z'),
      user: null,
    };
    client.message.findMany.mockResolvedValue([base]);

    // (a) linked to a lead -> the lead's name
    client.whatsappUnknownContact.findUnique
      .mockResolvedValueOnce({ id: 'contact-1' }) // the visibility check
      .mockResolvedValueOnce({ phoneE164: '919000000999', convertedToLeadId: 'lead-1' });
    client.lead.findUnique.mockResolvedValue({ name: 'Asha Menon' });
    let rows = await service.listContact(makeActor(), 'contact-1', 50);
    expect(rows[0]!.senderName).toBe('Asha Menon');

    // (b) not linked -> the phone number stands in for the customer
    vi.clearAllMocks();
    client.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client));
    client.message.findMany.mockResolvedValue([base]);
    client.whatsappUnknownContact.findUnique
      .mockResolvedValueOnce({ id: 'contact-1' })
      .mockResolvedValueOnce({ phoneE164: '919000000999', convertedToLeadId: null });
    rows = await service.listContact(makeActor(), 'contact-1', 50);
    expect(rows[0]!.senderName).toBe('919000000999');
    expect(client.lead.findUnique).not.toHaveBeenCalled();
  });

  it('never resolves a sender name per row (one lookup per request)', async () => {
    const { service, client } = makeService();
    client.whatsappUnknownContact.findUnique
      .mockResolvedValueOnce({ id: 'contact-1' })
      .mockResolvedValueOnce({ phoneE164: '919000000999', convertedToLeadId: null });
    client.message.findMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        id: `m${i}`,
        leadId: null,
        contactId: 'contact-1',
        direction: 'IN',
        channel: 'WHATSAPP',
        kind: 'CUSTOMER',
        body: `msg ${i}`,
        mediaUrl: null,
        mediaKey: null,
        mediaType: null,
        mediaFilename: null,
        createdAt: new Date('2026-09-25T10:00:00Z'),
        user: null,
      })),
    );

    await service.listContact(makeActor(), 'contact-1', 50);
    // 1 = existence check, 1 = sender-name resolution. Not 1 + 5.
    expect(client.whatsappUnknownContact.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe('sendToContact - reply on a contact thread', () => {
  it('rejects an empty body before touching the DB', async () => {
    const { service, client } = makeService();
    await expect(
      service.sendToContact(makeActor(), { contactId: 'contact-1', body: '   ' }),
    ).rejects.toThrow(/cannot be empty/);
    expect(client.whatsappUnknownContact.findUnique).not.toHaveBeenCalled();
  });

  it('404s when the contact is not visible', async () => {
    const { service, client } = makeService();
    client.whatsappUnknownContact.findUnique.mockResolvedValue(null);
    await expect(
      service.sendToContact(makeActor(), { contactId: 'contact-x', body: 'hi' }),
    ).rejects.toThrow(/contact-x not found/);
    expect(client.message.create).not.toHaveBeenCalled();
  });

  it('writes an OUT/WHATSAPP message keyed on contactId (no leadId) and enqueues WhatsApp', async () => {
    const { service, client, outbound } = makeService();
    client.whatsappUnknownContact.findUnique.mockResolvedValue({
      id: 'contact-1',
      phoneE164: '919000000999',
    });
    client.message.create.mockResolvedValue({
      id: 'msg-1',
      leadId: null,
      contactId: 'contact-1',
      direction: 'OUT',
      channel: 'WHATSAPP',
      kind: 'CUSTOMER',
      body: 'on our way',
      mediaUrl: null,
      mediaKey: null,
      mediaType: null,
      mediaFilename: null,
      createdAt: new Date('2026-09-25T11:00:00Z'),
    });

    const row = await service.sendToContact(makeActor(), {
      contactId: 'contact-1',
      body: 'on our way',
    });

    const data = client.message.create.mock.calls[0]![0]!.data;
    expect(data).toMatchObject({
      contactId: 'contact-1',
      direction: 'OUT',
      channel: 'WHATSAPP',
      kind: 'CUSTOMER',
      body: 'on our way',
    });
    // A contact thread must never carry a leadId - exactly one thread per row.
    expect(data).not.toHaveProperty('leadId');
    expect(row).toMatchObject({ contactId: 'contact-1', leadId: null, channel: 'WHATSAPP' });

    // The outbound must go on WHATSAPP as a FREEFORM reply, bound to the
    // contact (not a lead) - otherwise the reply would never be delivered.
    expect(outbound.enqueue).toHaveBeenCalledTimes(1);
    const enqueued = outbound.enqueue.mock.calls[0]![0];
    expect(enqueued).toMatchObject({
      messageId: 'msg-1',
      contactId: 'contact-1',
      sendType: 'FREEFORM',
      freeformBody: 'on our way',
    });
    expect(enqueued).not.toHaveProperty('leadId');

    // Audit row written in the same transaction.
    expect(client.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('carries media through to the enqueued outbound', async () => {
    const { service, client, outbound } = makeService();
    client.whatsappUnknownContact.findUnique.mockResolvedValue({
      id: 'contact-1',
      phoneE164: '919000000999',
    });
    client.message.create.mockResolvedValue({
      id: 'msg-2',
      leadId: null,
      contactId: 'contact-1',
      direction: 'OUT',
      channel: 'WHATSAPP',
      kind: 'CUSTOMER',
      body: 'layout attached',
      mediaUrl: '/api/bff/media/abc',
      mediaKey: 'abc',
      mediaType: 'image/png',
      mediaFilename: 'dot.png',
      createdAt: new Date('2026-09-25T11:00:00Z'),
    });

    await service.sendToContact(makeActor(), {
      contactId: 'contact-1',
      body: 'layout attached',
      mediaKey: 'abc',
      mediaMimeType: 'image/png',
      mediaFilename: 'dot.png',
    });

    expect(outbound.enqueue.mock.calls[0]![0]).toMatchObject({
      mediaKey: 'abc',
      mediaType: 'image/png',
      mediaFilename: 'dot.png',
    });
  });

  it('writes a Message and enqueues inside ONE transaction', async () => {
    const { service, client } = makeService();
    client.whatsappUnknownContact.findUnique.mockResolvedValue({
      id: 'contact-1',
      phoneE164: '919000000999',
    });
    client.message.create.mockResolvedValue({
      id: 'msg-3',
      leadId: null,
      contactId: 'contact-1',
      direction: 'OUT',
      channel: 'WHATSAPP',
      kind: 'CUSTOMER',
      body: 'hi',
      mediaUrl: null,
      mediaKey: null,
      mediaType: null,
      mediaFilename: null,
      createdAt: new Date('2026-09-25T11:00:00Z'),
    });

    await service.sendToContact(makeActor(), { contactId: 'contact-1', body: 'hi' });
    // One transaction for the whole write path, so a stored reply can never
    // exist without its outbound row.
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('markRead - per-user read position', () => {
  it('creates a row on first read of a thread', async () => {
    const { service, client } = makeService();
    client.chatReadState.findFirst.mockResolvedValue(null);
    client.chatReadState.create.mockResolvedValue({ id: 'rs-1' });

    const res = await service.markRead(makeActor({ sub: 'u-1' }), { leadId: 'lead-1' });

    expect(res).toEqual({ ok: true });
    const data = client.chatReadState.create.mock.calls[0]![0]!.data;
    expect(data).toMatchObject({ userId: 'u-1', leadId: 'lead-1' });
    // Never both - a row is either a lead thread or a contact thread.
    expect(data).not.toHaveProperty('contactId');
    expect(client.chatReadState.update).not.toHaveBeenCalled();
  });

  it('updates the existing row on a repeat read', async () => {
    const { service, client } = makeService();
    client.chatReadState.findFirst.mockResolvedValue({ id: 'rs-1' });
    client.chatReadState.update.mockResolvedValue({ id: 'rs-1' });

    await service.markRead(makeActor({ sub: 'u-1' }), { leadId: 'lead-1' });

    expect(client.chatReadState.update).toHaveBeenCalledTimes(1);
    expect(client.chatReadState.create).not.toHaveBeenCalled();
    expect(client.chatReadState.update.mock.calls[0]![0]!.where).toEqual({ id: 'rs-1' });
  });

  it('keys the contact variant on contactId', async () => {
    const { service, client } = makeService();
    client.chatReadState.findFirst.mockResolvedValue(null);
    client.chatReadState.create.mockResolvedValue({ id: 'rs-2' });

    await service.markRead(makeActor({ sub: 'u-9' }), { contactId: 'contact-1' });

    expect(client.chatReadState.create.mock.calls[0]![0]!.data).toMatchObject({
      userId: 'u-9',
      contactId: 'contact-1',
    });
    expect(client.chatReadState.findFirst.mock.calls[0]![0]!.where).toEqual({
      userId: 'u-9',
      contactId: 'contact-1',
    });
  });

  it('scopes the read row to the acting user, never another user', async () => {
    const { service, client } = makeService();
    client.chatReadState.findFirst.mockResolvedValue(null);
    client.chatReadState.create.mockResolvedValue({ id: 'rs-3' });

    await service.markRead(makeActor({ sub: 'mgr-77' }), { leadId: 'lead-1' });

    expect(client.chatReadState.findFirst.mock.calls[0]![0]!.where.userId).toBe('mgr-77');
    expect(client.chatReadState.create.mock.calls[0]![0]!.data.userId).toBe('mgr-77');
  });
});
