// Smoke test for @shadhil/api-types.
// Verifies every Zod schema parses a valid example and rejects a bad one.

import { describe, it, expect } from 'vitest';
import {
  RoleSchema,
  LeadStateSchema,
  LoginDtoSchema,
  CreateLeadDtoSchema,
  CreateSiteVisitDtoSchema,
  SendMessageDtoSchema,
  CreateBookingDtoSchema,
  CreateReminderDtoSchema,
  MarkReadDtoSchema,
  AuditLogQueryDtoSchema,
  WhatsAppWebhookPayloadSchema,
  PaginationDtoSchema,
} from '../src';

describe('@shadhil/api-types — enums', () => {
  it('Role accepts valid role', () => {
    expect(RoleSchema.parse('ADMIN')).toBe('ADMIN');
  });
  it('Role rejects garbage', () => {
    expect(() => RoleSchema.parse('GOD')).toThrow();
  });
  it('LeadState accepts every state', () => {
    for (const s of [
      'NEW',
      'CONTACTED',
      'VISIT_REQUESTED',
      'VISIT_SCHEDULED',
      'VISITED',
      'NEGOTIATION',
      'BOOKING_INITIATED',
      'WON',
      'LOST',
      'COLD',
      'RESCHEDULED',
      'NO_SHOW',
    ]) {
      expect(LeadStateSchema.parse(s)).toBe(s);
    }
  });
});

describe('@shadhil/api-types — auth DTOs', () => {
  it('LoginDto accepts valid email+password', () => {
    const r = LoginDtoSchema.parse({ email: 'a@b.com', password: 'pw' });
    expect(r.email).toBe('a@b.com');
  });
  it('LoginDto rejects missing email', () => {
    expect(() => LoginDtoSchema.parse({ password: 'pw' })).toThrow();
  });
  it('LoginDto lowercases email', () => {
    const r = LoginDtoSchema.parse({ email: 'MIXED@Case.com', password: 'pw' });
    expect(r.email).toBe('mixed@case.com');
  });
});

describe('@shadhil/api-types — lead DTOs', () => {
  it('CreateLeadDto accepts valid lead with 10-digit phone', () => {
    const r = CreateLeadDtoSchema.parse({
      name: 'Rajesh',
      phone: '9876543210',
      source: 'Meta',
    });
    expect(r.phone).toBe('9876543210');
  });
  it('CreateLeadDto normalizes phone with +91 prefix', () => {
    const r = CreateLeadDtoSchema.parse({
      name: 'Priya',
      phone: '+91 98765 43210',
      source: 'Google',
    });
    expect(r.phone).toBe('919876543210');
  });
  it('CreateLeadDto rejects too-short phone', () => {
    expect(() =>
      CreateLeadDtoSchema.parse({ name: 'x', phone: '123', source: 'Meta' }),
    ).toThrow();
  });
  it('CreateLeadDto rejects empty name', () => {
    expect(() =>
      CreateLeadDtoSchema.parse({ name: '  ', phone: '9876543210', source: 'Meta' }),
    ).toThrow();
  });
});

describe('@shadhil/api-types — visit DTOs', () => {
  it('CreateSiteVisitDto accepts future ISO datetime', () => {
    const r = CreateSiteVisitDtoSchema.parse({
      leadId: 'cl1234567890abcdefghij',
      scheduledFor: '2027-01-01T10:00:00+05:30',
    });
    expect(r.leadId).toBe('cl1234567890abcdefghij');
  });
  it('CreateSiteVisitDto rejects past datetime', () => {
    expect(() =>
      CreateSiteVisitDtoSchema.parse({
        leadId: 'cl1234567890abcdefghij',
        scheduledFor: '2020-01-01T10:00:00+05:30',
      }),
    ).toThrow(/future/);
  });
});

describe('@shadhil/api-types — chat DTOs', () => {
  it('SendMessageDto accepts valid message', () => {
    const r = SendMessageDtoSchema.parse({
      leadId: 'cl1234567890abcdefghij',
      body: 'Hello, interested in 3BHK',
    });
    expect(r.body).toContain('3BHK');
  });
  it('SendMessageDto rejects empty body', () => {
    expect(() =>
      SendMessageDtoSchema.parse({
        leadId: 'cl1234567890abcdefghij',
        body: '',
      }),
    ).toThrow();
  });
});

describe('@shadhil/api-types — booking DTOs', () => {
  it('CreateBookingDto accepts positive amount', () => {
    const r = CreateBookingDtoSchema.parse({
      leadId: 'cl1234567890abcdefghij',
      unitId: 'cl9999999999abcdefghij',
      amount: 75_00_000,
    });
    expect(r.amount).toBe(75_00_000);
  });
  it('CreateBookingDto rejects negative amount', () => {
    expect(() =>
      CreateBookingDtoSchema.parse({
        leadId: 'cl1234567890abcdefghij',
        unitId: 'cl9999999999abcdefghij',
        amount: -1,
      }),
    ).toThrow();
  });
});

describe('@shadhil/api-types — reminder DTOs', () => {
  it('CreateReminderDto accepts valid future reminder', () => {
    const r = CreateReminderDtoSchema.parse({
      leadId: 'cl1234567890abcdefghij',
      userId: 'cl8888888888abcdefghij',
      type: 'PRE_VISIT_STAFF',
      scheduledFor: '2027-01-01T08:00:00+05:30',
    });
    expect(r.type).toBe('PRE_VISIT_STAFF');
  });
});

describe('@shadhil/api-types — notification DTOs', () => {
  it('MarkReadDto accepts empty array (mark all)', () => {
    const r = MarkReadDtoSchema.parse({ notificationIds: [] });
    expect(r.notificationIds).toEqual([]);
  });
});

describe('@shadhil/api-types — audit DTOs', () => {
  it('AuditLogQueryDto accepts userId + date range', () => {
    const r = AuditLogQueryDtoSchema.parse({
      userId: 'cl1234567890abcdefghij',
      from: '2026-01-01T00:00:00+05:30',
      to: '2026-12-31T23:59:59+05:30',
      limit: 100,
    });
    expect(r.limit).toBe(100);
  });
});

describe('@shadhil/api-types — webhook DTOs', () => {
  it('WhatsAppWebhookPayloadSchema accepts minimal valid payload', () => {
    const r = WhatsAppWebhookPayloadSchema.parse({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'ENTRY_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '919876543210',
                  phone_number_id: '12345',
                },
              },
              field: 'messages',
            },
          ],
        },
      ],
    });
    expect(r.object).toBe('whatsapp_business_account');
  });
  it('WhatsAppWebhookPayloadSchema rejects wrong object value', () => {
    expect(() =>
      WhatsAppWebhookPayloadSchema.parse({
        object: 'wrong',
        entry: [],
      }),
    ).toThrow();
  });
});

describe('@shadhil/api-types — common DTOs', () => {
  it('PaginationDtoSchema applies defaults', () => {
    const r = PaginationDtoSchema.parse({});
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
  });
  it('PaginationDtoSchema caps limit at 200', () => {
    expect(() => PaginationDtoSchema.parse({ limit: 500 })).toThrow();
  });
});
