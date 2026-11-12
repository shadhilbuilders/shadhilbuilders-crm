// CreateUserFormSchema + lead search for CUSTOMER (issue #8 slice 2).
// protects= a CUSTOMER cannot be submitted without a lead, a staff role needs
//           no lead, lead options render "name - phone", and the picker's
//           remote search hits /leads?search=&limit= and unwraps the
//           paginated envelope; fails_when= the lead rule is dropped or
//           applied to staff, junk rows crash the picker, or the search URL
//           loses its query / reads the wrong envelope shape; no_claim= no
//           dialog rendering, no Combobox interaction, no real network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

// Keep the real `qs` (the URL under test) and stub only the transport.
vi.mock('@/apis/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/apis/client')>();
  return { ...actual, api: apiMock };
});

import { CreateUserFormSchema } from './CreateUserForm';
import { fetchLeadOptions, toLeadOptions } from './CustomerLeadField';

const base = { name: 'Asha', email: 'asha@x.in', password: 'Passw0rd!x' };

describe('CreateUserFormSchema (CUSTOMER)', () => {
  it('rejects a CUSTOMER without a lead, with the error on customerLeadId', () => {
    const res = CreateUserFormSchema.safeParse({ ...base, role: 'CUSTOMER' });
    expect(res.success).toBe(false);
    expect(res.error?.issues.some((i) => i.path[0] === 'customerLeadId')).toBe(true);
  });
  it('accepts a CUSTOMER with a lead and no team', () => {
    expect(
      CreateUserFormSchema.safeParse({ ...base, role: 'CUSTOMER', customerLeadId: 'lead-1' })
        .success,
    ).toBe(true);
  });
  it('does not ask a staff role for a lead', () => {
    expect(CreateUserFormSchema.safeParse({ ...base, role: 'MANAGER' }).success).toBe(true);
  });
});

describe('toLeadOptions', () => {
  it('maps leads to "name - phone" and skips malformed rows', () => {
    expect(
      toLeadOptions([
        { id: 'l1', name: 'Vikram', phone: '98765' },
        { id: 5 },
        null,
        { id: 'l2', name: 'Meera' },
      ]),
    ).toEqual([
      { value: 'l1', label: 'Vikram - 98765' },
      { value: 'l2', label: 'Meera' },
    ]);
    expect(toLeadOptions(undefined)).toEqual([]);
  });
});

describe('fetchLeadOptions', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  it('searches /leads by the trimmed query and unwraps the { rows } envelope', async () => {
    apiMock.mockResolvedValue({
      total: 1,
      rows: [{ id: 'l1', name: 'Vikram', phone: '98765' }],
    });

    const options = await fetchLeadOptions('  vikram  ');

    expect(apiMock).toHaveBeenCalledTimes(1);
    const path = apiMock.mock.calls[0]?.[0] as string;
    expect(path.startsWith('/leads?')).toBe(true);
    expect(path).toContain('search=vikram');
    expect(path).toContain('limit=20');
    expect(options).toEqual([{ value: 'l1', label: 'Vikram - 98765' }]);
  });

  it('accepts a bare array response', async () => {
    apiMock.mockResolvedValue([{ id: 'l2', name: 'Meera', phone: '90000' }]);

    expect(await fetchLeadOptions('meera')).toEqual([{ value: 'l2', label: 'Meera - 90000' }]);
  });

  it('does not fetch on a blank query (never dumps the org lead list)', async () => {
    expect(await fetchLeadOptions('   ')).toEqual([]);
    expect(apiMock).not.toHaveBeenCalled();
  });
});
