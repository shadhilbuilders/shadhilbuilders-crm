'use client';

// AssignedEngineerRow - who photographs this villa (2026-11-10).
//
// ADMIN/OWNER get a searchable picker over the project's ENGINEERs (one engineer
// per villa; "Not assigned" unassigns). MANAGER sees the name read-only. Site
// roles see nothing: an engineer's whole product is the villas assigned to them.
import { Combobox, toast } from '@paalstack/react-ui';

import { useAssignUnitEngineer, type UnitRow } from '@/hooks/queries/inventory';
import { useUsers } from '@/hooks/queries/users';
import { isAdminLike, useSessionUser } from '@/lib/session';

/** Sentinel option value for "no engineer"; never sent to the API. */
export const NOT_ASSIGNED = '__not_assigned__';

const NOT_ASSIGNED_LABEL = 'Not assigned';

function ReadOnlyRow({ name }: { name: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between gap-4 p-2" data-qa="unit-assigned-engineer">
      <span className="text-muted-foreground text-sm">Assigned engineer</span>
      <span className="text-sm font-medium">{name ?? NOT_ASSIGNED_LABEL}</span>
    </div>
  );
}

function EngineerPicker({ unit }: { unit: UnitRow }) {
  const engineers = useUsers({ role: ['ENGINEER'], projectId: unit.projectId, limit: 100 });
  const assign = useAssignUnitEngineer();
  const options = [
    { value: NOT_ASSIGNED, label: NOT_ASSIGNED_LABEL },
    ...(engineers.data?.rows ?? [])
      .map((u) => ({ value: u.id, label: u.name }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];

  const onChange = (next: string): void => {
    const engineerId = next === NOT_ASSIGNED ? null : next;
    if (engineerId === (unit.assignedEngineerId ?? null)) return;
    assign.mutate(
      { unitId: unit.id, engineerId },
      {
        onSuccess: () => {
          toast.success(engineerId === null ? 'Villa unassigned.' : 'Engineer assigned.');
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Could not update the assignment.');
        },
      },
    );
  };

  return (
    <div className="flex items-center justify-between gap-4 p-2">
      <span className="text-muted-foreground text-sm">Assigned engineer</span>
      <Combobox
        options={options}
        value={unit.assignedEngineerId ?? NOT_ASSIGNED}
        onValueChange={(v) => onChange(v ?? NOT_ASSIGNED)}
        selectOptionAsValue
        placeholder={NOT_ASSIGNED_LABEL}
        emptyOptionMessage="No engineers on this project's teams."
        loadingMessage="Loading engineers..."
        disabled={assign.isPending}
        className="w-56"
        data-qa="unit-assign-engineer"
      />
    </div>
  );
}

export function AssignedEngineerRow({ unit }: { unit: UnitRow }) {
  const { user } = useSessionUser();
  if (user === null) return null;
  if (isAdminLike(user.role)) return <EngineerPicker unit={unit} />;
  if (user.role === 'MANAGER') return <ReadOnlyRow name={unit.assignedEngineerName} />;
  return null;
}
