'use client';

// UserPicker - searchable Combobox over the org's users (Staff Permission
// page).
//   - Opening it with nothing typed shows the first 10 users (preloaded via
//     `useUsers` and passed as `options`: the Combobox only calls
//     `fetchOptions` once the admin has typed something).
//   - Typing searches server-side (name or email, GET /api/users?search=...,
//     2-character minimum like the Users table). The Combobox debounces the
//     call (300ms) and shows its own loading state.
//   - A user selected via ?userId= who is not in the first 10 is fetched by id
//     so the input can still show who is selected.
import { useMemo } from 'react';
import { Combobox, type ComboboxOptionType } from '@paalstack/react-ui';

import { api, qs } from '@/apis/client';
import { useUser, useUsers, type UsersListResult } from '@/hooks/queries/users';
import { labelFor } from '@/lib/labels';
import type { Role } from '@/apis/client';

const PICKER_LIMIT = 10;
const MIN_SEARCH_LENGTH = 2;

type PickerUser = { id: string; name: string; email: string; role: Role };

export function toUserOption(u: PickerUser): { value: string; label: string } {
  return {
    value: u.id,
    label: `${u.name} - ${labelFor('role', u.role)} - ${u.email}`,
  };
}

/** Combobox `fetchOptions` implementation. Errors propagate (never swallowed). */
export async function loadUserPickerOptions(
  query: string,
): Promise<ComboboxOptionType[]> {
  const trimmed = query.trim();
  const search = trimmed.length >= MIN_SEARCH_LENGTH ? trimmed : undefined;
  const result = await api<UsersListResult>(
    `/users${qs({ search, limit: PICKER_LIMIT })}`,
  );
  return result.rows.map(toUserOption);
}

export function UserPicker({
  value,
  onValueChange,
}: {
  /** Selected user id, or '' for none. */
  value: string;
  onValueChange: (userId: string) => void;
}) {
  const defaultUsers = useUsers({ limit: PICKER_LIMIT, offset: 0 });
  const selectedUser = useUser(value === '' ? undefined : value);

  const options = useMemo(() => {
    const rows: PickerUser[] = [...(defaultUsers.data?.rows ?? [])];
    const selected = selectedUser.data;
    if (selected !== undefined && !rows.some((u) => u.id === selected.id)) {
      rows.unshift(selected);
    }
    return rows.map(toUserOption);
  }, [defaultUsers.data, selectedUser.data]);

  return (
    <Combobox
      value={value}
      onValueChange={(next) => onValueChange(typeof next === 'string' ? next : '')}
      options={options}
      isLoading={defaultUsers.isLoading}
      fetchOptions={loadUserPickerOptions}
      selectOptionAsValue
      placeholder="Search by username or email..."
      emptyOptionMessage="No staff match your search."
      loadingMessage="Searching staff..."
      className="w-full max-w-sm"
      inputProps={{ 'aria-label': 'Search staff by username' }}
      data-qa="staff-permission-user-picker"
    />
  );
}
