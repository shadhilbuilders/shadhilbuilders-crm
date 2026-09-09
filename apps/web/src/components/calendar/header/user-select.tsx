'use client';

// UserSelect (adapted from lramos33/big-calendar to @paalstack/react-ui
// Combobox). Filters the calendar by sales exec. Only shows execs linked
// to the active project (derived from the project's visits).
import { Combobox } from '@paalstack/react-ui';

import { useCalendar } from '../calendar-context';
import { useMemo } from 'react';

export function UserSelect() {
  const { users, selectedUserId, setSelectedUserId } = useCalendar();

  const options = useMemo(() => {
    return [
    {
      value: 'all',
      label: 'All',
    },
    ...users.map((user) => ({
      value: user.id,
      label: user.name,
    })),
  ]}, [users]);

  const selectedOption = useMemo(() => {
    return options.find((option) => option.value === selectedUserId);
  }, [options, selectedUserId]);

  return (
    <Combobox
      options={options}
      value={selectedOption}
      onValueChange={(option) => setSelectedUserId(option?.value ?? "all")}
      placeholder="Filter by exec"
      emptyOptionMessage="No execs in this project"
      className="flex-1 md:w-48"
    />
  );
}
