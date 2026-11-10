'use client';

// UserUnitsCard - the villas assigned to ONE site engineer (2026-11-10).
//
// Mounted on /admin/users/[userId] for ENGINEER targets in place of the Leads
// card (an engineer has no lead work). Pick a project, tick the villas this
// engineer should photograph, Save. The server replaces the engineer's set
// within that project in one transaction; a villa ticked here that belonged to
// another engineer moves to this one (that engineer is notified).
import { useMemo, useState } from 'react';

import { Alert, Button, Checkbox, Combobox, TypographyP, toast } from '@paalstack/react-ui';

import { Skeleton } from '@/components/shared/Skeleton';
import {
  useAssignUserUnits,
  useInventoryUnits,
  type UnitRow,
} from '@/hooks/queries/inventory';
import { useProjects } from '@/hooks/queries/projects';

/** Pure: the unit ids this engineer holds in the loaded rows. */
export function assignedIdsFor(rows: readonly UnitRow[], engineerId: string): ReadonlySet<string> {
  return new Set(rows.filter((r) => r.assignedEngineerId === engineerId).map((r) => r.id));
}

/** Pure: has the selection diverged from what the server holds? */
export function isDirty(selected: ReadonlySet<string>, saved: ReadonlySet<string>): boolean {
  if (selected.size !== saved.size) return true;
  for (const id of selected) if (!saved.has(id)) return true;
  return false;
}

/** Pure: a new set with `id` toggled (never mutates the input). */
export function toggled(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

function villaLabel(row: UnitRow, engineerId: string): string {
  const other =
    row.assignedEngineerId && row.assignedEngineerId !== engineerId
      ? ` - assigned to ${row.assignedEngineerName ?? 'another engineer'}`
      : '';
  return `${row.unitNumber} (${row.phaseName})${other}`;
}

export function UserUnitsCard({ engineerId }: { engineerId: string }) {
  const projectsQuery = useProjects();
  const [projectChoice, setProjectChoice] = useState('');
  const projects = projectsQuery.data ?? [];
  const projectId = projectChoice !== '' ? projectChoice : (projects[0]?.id ?? '');

  const unitsQuery = useInventoryUnits({
    projectId: projectId !== '' ? projectId : undefined,
    limit: 200,
  });
  const rows = useMemo(
    () => (Array.isArray(unitsQuery.data) ? (unitsQuery.data as UnitRow[]) : []),
    [unitsQuery.data],
  );
  const saved = useMemo(() => assignedIdsFor(rows, engineerId), [rows, engineerId]);

  // null = untouched: the checkboxes mirror the server. Cleared on project
  // change and after a successful save so a refetch is never masked.
  const [edits, setEdits] = useState<ReadonlySet<string> | null>(null);
  const selected = edits ?? saved;
  const dirty = edits !== null && isDirty(edits, saved);
  const assign = useAssignUserUnits();

  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }));

  const onSave = (): void => {
    assign.mutate(
      { projectId, engineerId, unitIds: [...selected] },
      {
        onSuccess: (res) => {
          setEdits(null);
          toast.success(`Saved: ${res.assigned} assigned, ${res.unassigned} removed.`);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Could not save the assignments.');
        },
      },
    );
  };

  return (
    <div className="space-y-4" data-qa="user-units-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Assigned villas</h3>
          <TypographyP className="text-muted-foreground text-sm">
            This engineer sees only the villas ticked below on their Site updates page.
          </TypographyP>
        </div>
        <Combobox
          options={projectOptions}
          value={projectId}
          onValueChange={(v) => {
            setProjectChoice(v ?? '');
            setEdits(null);
          }}
          selectOptionAsValue
          placeholder="Select project"
          emptyOptionMessage="No projects."
          className="w-56"
          data-qa="user-units-project"
        />
      </div>

      {unitsQuery.isLoading ? (
        <Skeleton variant="text" />
      ) : unitsQuery.isError ? (
        <Alert softBackground="danger" data-qa="user-units-error">
          Could not load villas for this project. Reload and try again.
        </Alert>
      ) : rows.length === 0 ? (
        <TypographyP className="text-muted-foreground text-sm" data-qa="user-units-empty">
          This project has no villas yet.
        </TypographyP>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" data-qa="user-units-list">
          {rows.map((row) => (
            <li key={row.id}>
              <Checkbox
                checked={selected.has(row.id)}
                onCheckedChange={(on: boolean) => setEdits(toggled(selected, row.id, on))}
                label={villaLabel(row, engineerId)}
                data-qa={`user-unit-${row.id}`}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <Button
          onClick={onSave}
          disabled={!dirty || assign.isPending || projectId === ''}
          isLoading={assign.isPending}
          data-qa="user-units-save"
        >
          Save assignments
        </Button>
        <span className="text-muted-foreground text-xs">{selected.size} selected</span>
      </div>
    </div>
  );
}
