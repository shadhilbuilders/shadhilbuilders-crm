// Smoke test for @shadhil/api-types.
// Verifies every Zod schema parses a valid example and rejects a bad one.

import { describe, it, expect } from 'vitest';
import {
  RoleSchema,
  LeadStateSchema,
  LoginDtoSchema,
  CreateLeadDtoSchema,
  LeadFilterDtoSchema,
  CreateSiteVisitDtoSchema,
  SendMessageDtoSchema,
  CreateBookingDtoSchema,
  CreateReminderDtoSchema,
  MarkReadDtoSchema,
  AuditLogQueryDtoSchema,
  WhatsAppWebhookPayloadSchema,
  PaginationDtoSchema,
  ChangePasswordDtoSchema,
  ChangePasswordFormSchema,
  CreateProjectDtoSchema,
  UpdateProjectDtoSchema,
  ProjectFilterDtoSchema,
  CreateUnitDtoSchema,
  UpdateUnitDtoSchema,
  UnitFilterDtoSchema,
} from '../src';

describe('@shadhil/api-types - enums', () => {
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

describe('@shadhil/api-types - auth DTOs', () => {
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

describe('@shadhil/api-types - lead DTOs', () => {
  it('CreateLeadDto accepts valid lead with 10-digit phone (normalized to E.164)', () => {
    const r = CreateLeadDtoSchema.parse({
      name: 'Rajesh',
      phone: '9876543210',
      source: 'Meta',
    });
    // Landing-page normalizePhone: bare 10-digit Indian mobile → +91 prefix.
    expect(r.phone).toBe('919876543210');
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
  // T-PROJID-CUID2 (2026-09-08): seed projects now carry real cuid2 ids.
  // The create DTO requires a valid cuid2, so the seeded Metro Heights id
  // must parse. Regression guard - a readable id (e.g. seed-project-*)
  // would fail z.cuid2() and break lead creation from /[projectId]/leads/new.
  it('CreateLeadDto accepts the seeded Metro Heights project id (cuid2)', () => {
    const r = CreateLeadDtoSchema.parse({
      name: 'Rajesh',
      phone: '9876543210',
      source: 'Referral',
      projectId: 'oe6g1xkagiisnn4oeefpdyhk',
    });
    expect(r.projectId).toBe('oe6g1xkagiisnn4oeefpdyhk');
  });
  it('LeadFilterDto accepts the seeded Metro Heights project id (cuid2)', () => {
    const r = LeadFilterDtoSchema.parse({
      projectId: 'oe6g1xkagiisnn4oeefpdyhk',
    });
    expect(r.projectId).toBe('oe6g1xkagiisnn4oeefpdyhk');
  });
  it('CreateLeadDto rejects a readable (non-cuid2) project id', () => {
    expect(() =>
      CreateLeadDtoSchema.parse({
        name: 'Rajesh',
        phone: '9876543210',
        source: 'Referral',
        projectId: 'seed-project-metro-heights',
      }),
    ).toThrow(/cuid2/i);
  });
});

describe('@shadhil/api-types - project DTOs', () => {
  it('CreateProjectDto accepts valid project (RERA/CMDA optional)', () => {
    const r = CreateProjectDtoSchema.parse({
      name: 'Shadhil Skyline Towers',
      address: 'Whitefield, Bengaluru',
      reraNumber: 'TN/02/2024/0001',
      cmdaNumber: 'PP/2024/BLR/123',
    });
    expect(r.name).toBe('Shadhil Skyline Towers');
  });

  it('CreateProjectDto rejects empty name', () => {
    expect(() =>
      CreateProjectDtoSchema.parse({ name: '  ', address: 'City' }),
    ).toThrow();
  });

  // Regression (2026-09-10): the edit form sends `null` to CLEAR an optional
  // compliance field (reraNumber/cmdaNumber). The schema must accept it -
  // `.partial()` alone does NOT (it omits `.nullable()`).
  it('UpdateProjectDto accepts explicit null to clear rera/cmda', () => {
    const r = UpdateProjectDtoSchema.parse({
      reraNumber: null,
      cmdaNumber: null,
    });
    expect(r.reraNumber).toBeNull();
    expect(r.cmdaNumber).toBeNull();
  });

  it('UpdateProjectDto accepts partial string updates', () => {
    const r = UpdateProjectDtoSchema.parse({ name: 'Renamed', reraNumber: 'X' });
    expect(r.name).toBe('Renamed');
    expect(r.reraNumber).toBe('X');
  });

  it('UpdateProjectDto rejects a number for reraNumber', () => {
    expect(() =>
      UpdateProjectDtoSchema.parse({ reraNumber: 12345 }),
    ).toThrow();
  });
});

describe('@shadhil/api-types - visit DTOs', () => {
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

describe('@shadhil/api-types - chat DTOs', () => {
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

describe('@shadhil/api-types - booking DTOs', () => {
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

describe('@shadhil/api-types - reminder DTOs', () => {
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

describe('@shadhil/api-types - notification DTOs', () => {
  it('MarkReadDto accepts empty array (mark all)', () => {
    const r = MarkReadDtoSchema.parse({ notificationIds: [] });
    expect(r.notificationIds).toEqual([]);
  });
});

describe('@shadhil/api-types - audit DTOs', () => {
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

describe('@shadhil/api-types - webhook DTOs', () => {
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

describe('@shadhil/api-types - common DTOs', () => {
  it('PaginationDtoSchema applies defaults', () => {
    const r = PaginationDtoSchema.parse({});
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
  });
  it('PaginationDtoSchema caps limit at 200', () => {
    expect(() => PaginationDtoSchema.parse({ limit: 500 })).toThrow();
  });
});

describe('@shadhil/api-types - change-password (T-S page + zod validation)', () => {
  const valid = { oldPassword: 'oldpass1', newPassword: 'newpass12', confirmPassword: 'newpass12' };

  it('ChangePasswordDtoSchema (server wire contract) parses old+new only', () => {
    const r = ChangePasswordDtoSchema.parse({
      oldPassword: 'oldpass12',
      newPassword: 'newpass12',
    });
    expect(r.newPassword).toBe('newpass12');
  });

  it('ChangePasswordFormSchema parses a valid matching trio', () => {
    const r = ChangePasswordFormSchema.parse(valid);
    expect(r.confirmPassword).toBe('newpass12');
  });

  it('Form schema rejects newPassword under 8 chars (same rule as the server DTO)', () => {
    expect(() =>
      ChangePasswordFormSchema.parse({ ...valid, newPassword: 'short' }),
    ).toThrow();
  });

  it('Form schema rejects empty confirmPassword', () => {
    expect(() =>
      ChangePasswordFormSchema.parse({ ...valid, confirmPassword: '' }),
    ).toThrow();
  });

  it('Form schema rejects mismatched confirmation, attaching the error to confirmPassword', () => {
    const result = ChangePasswordFormSchema.safeParse({
      ...valid,
      confirmPassword: 'different456',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('confirmPassword');
      const confirmIssue = result.error.issues.find(
        (i) => i.path.join('.') === 'confirmPassword',
      );
      expect(confirmIssue?.message).toBe(
        'New password and confirmation do not match',
      );
    }
  });

  it('Form schema is a strict superset: every value valid for the FORM is valid for the server DTO (no drift)', () => {
    // The drift guard: strip confirmPassword and the remaining payload
    // MUST satisfy the server contract. If someone loosens the form
    // schema independently of the server DTO, this fails.
    const formParsed = ChangePasswordFormSchema.parse(valid);
    const wire = ChangePasswordDtoSchema.safeParse({
      oldPassword: formParsed.oldPassword,
      newPassword: formParsed.newPassword,
    });
    expect(wire.success).toBe(true);
  });

  it('Server DTO rejects newPassword under 8 chars (unchanged contract)', () => {
    expect(() =>
      ChangePasswordDtoSchema.parse({ oldPassword: 'x', newPassword: 'short' }),
    ).toThrow();
  });
});

describe('@shadhil/api-types - inventory DTOs', () => {
  // Phase.id is a real cuid2 (T-PROJID-CUID2) - the seeded Metro Heights
  // phase ids are cuid2. The create DTO requires a valid cuid2 phaseId.
  const PHASE_ID = 'zpn4utpch0ncq4esh46cl4ug';

  it('CreateUnitDto accepts a valid unit (facing/sqft optional)', () => {
    const r = CreateUnitDtoSchema.parse({
      phaseId: PHASE_ID,
      unitNumber: 'A-101',
      bhk: 3,
      facing: 'North',
      sqft: 1450,
      price: 5_000_000,
    });
    expect(r.unitNumber).toBe('A-101');
    expect(r.price).toBe(5_000_000);
  });

  it('CreateUnitDto rejects a non-positive price', () => {
    expect(() =>
      CreateUnitDtoSchema.parse({
        phaseId: PHASE_ID,
        unitNumber: 'A-101',
        bhk: 3,
        price: 0,
      }),
    ).toThrow();
  });

  it('CreateUnitDto rejects bhk outside 1-10', () => {
    expect(() =>
      CreateUnitDtoSchema.parse({
        phaseId: PHASE_ID,
        unitNumber: 'A-101',
        bhk: 0,
        price: 1,
      }),
    ).toThrow();
  });

  it('CreateUnitDto rejects a readable (non-cuid2) phase id', () => {
    expect(() =>
      CreateUnitDtoSchema.parse({
        phaseId: 'seed-phase-metro-a',
        unitNumber: 'A-101',
        bhk: 3,
        price: 1,
      }),
    ).toThrow(/cuid2/i);
  });

  it('UpdateUnitDto accepts a partial update (status flip)', () => {
    const r = UpdateUnitDtoSchema.parse({ status: 'SOLD' });
    expect(r.status).toBe('SOLD');
  });

  it('UpdateUnitDto accepts explicit null to clear facing', () => {
    const r = UpdateUnitDtoSchema.parse({ facing: null });
    expect(r.facing).toBeNull();
  });

  it('UnitFilterDto accepts the seeded Metro Heights project id (cuid2)', () => {
    const r = UnitFilterDtoSchema.parse({
      projectId: 'oe6g1xkagiisnn4oeefpdyhk',
    });
    expect(r.projectId).toBe('oe6g1xkagiisnn4oeefpdyhk');
  });

  it('UnitFilterDto accepts a status array', () => {
    const r = UnitFilterDtoSchema.parse({ status: ['AVAILABLE', 'HOLD'] });
    expect(r.status).toEqual(['AVAILABLE', 'HOLD']);
  });

  it('UnitFilterDto rejects a readable (non-cuid2) project id', () => {
    expect(() =>
      UnitFilterDtoSchema.parse({ projectId: 'seed-project-metro-heights' }),
    ).toThrow(/cuid2/i);
  });
});
