// UserPicker option loading: the Combobox `fetchOptions` callback hits the
// users search endpoint (server-side search, >= 2 chars) and maps rows to
// `{ value: id, label }` options. Only the `api` network boundary is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock('@/apis/client', () => ({
  api: mocks.api,
  qs: (params: Record<string, unknown>) => {
    const entries = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== '',
    );
    return entries.length === 0
      ? ''
      : `?${entries.map(([k, v]) => `${k}=${String(v)}`).join('&')}`;
  },
}));

import { loadUserPickerOptions, toUserOption } from './UserPicker';

const rows = [
  {
    id: 'u-1',
    name: 'Priya Sharma',
    email: 'priya@example.com',
    role: 'SALES_EXEC',
    teamId: 't-1',
    projects: [],
  },
  {
    id: 'u-2',
    name: 'Ravi Manager',
    email: 'ravi@example.com',
    role: 'MANAGER',
    teamId: null,
    projects: [],
  },
];

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockResolvedValue({ rows, total: 2 });
});

describe('toUserOption', () => {
  it('builds an id-valued option labelled with name, role and email', () => {
    expect(
      toUserOption({ id: 'u-9', name: 'Kiran Rao', email: 'kiran@example.com', role: 'TELECALLER' }),
    ).toEqual({
      value: 'u-9',
      label: 'Kiran Rao - Telecaller - kiran@example.com',
    });
  });
});

describe('loadUserPickerOptions', () => {
  it('maps users to id-valued options with name, role and email in the label', async () => {
    const options = await loadUserPickerOptions('pri');

    expect(options).toEqual([
      { value: 'u-1', label: 'Priya Sharma - Sales Executive - priya@example.com' },
      { value: 'u-2', label: 'Ravi Manager - Manager - ravi@example.com' },
    ]);
  });

  it('sends a trimmed search of 2+ characters to the users endpoint', async () => {
    await loadUserPickerOptions('  pri ');

    expect(mocks.api).toHaveBeenCalledTimes(1);
    const url = mocks.api.mock.calls[0]?.[0] as string;
    expect(url).toContain('/users?');
    expect(url).toContain('search=pri');
    expect(url).toContain('limit=10');
  });

  it('lists the first page without a search param when the query is under 2 characters', async () => {
    await loadUserPickerOptions('p');

    const url = mocks.api.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('search=');
    expect(url).toContain('limit=10');
  });

  it('propagates API failures instead of swallowing them', async () => {
    mocks.api.mockRejectedValue(new Error('API 500'));

    await expect(loadUserPickerOptions('pri')).rejects.toThrow('API 500');
  });
});
