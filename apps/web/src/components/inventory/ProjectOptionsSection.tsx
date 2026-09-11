'use client';

// ProjectOptionsSection - per-project facing/BHK option sets, rendered as
// individual cards (one per type) so the caller can lay them out in a grid
// alongside the Phases card.
//
// Mirrors the PhasesSection structure: a Card with a header title + "Add
// <type>" button (MANAGER/ADMIN/OWNER), and a divided list of rows (value +
// unit-count + delete button). Add opens a Dialog. Delete opens an
// AlertDialog confirm (destructive action - user preference); the backend 409
// (value in use by a unit) surfaces via toast.
//
// Options are add/remove only - renaming a facing/BHK doesn't make sense
// (categorical labels), so there is no edit action.
import { useState } from 'react';

import {
  AlertDialog,
  Badge,
  Button,
  Card,
  toast,
} from '@paalstack/react-ui';
import { LuPlus, LuTrash2 } from '@paalstack/react-icons/lu';

import {
  useDeleteProjectOption,
  type ProjectOptionRow,
} from '@/hooks/queries/inventory';

import { ProjectOptionManageDialog, type OptionType } from './ProjectOptionManageDialog';

function groupLabel(type: OptionType): string {
  return type === 'FACING' ? 'Facing' : 'BHK';
}

function OptionGroup({
  type,
  rows,
  projectId,
  canManage,
}: {
  type: OptionType;
  rows: ProjectOptionRow[];
  projectId: string | null;
  canManage: boolean;
}) {
  const deleteOption = useDeleteProjectOption();
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectOptionRow | null>(null);
  const label = groupLabel(type);

  return (
    <Card
      header={{ title: label }}
      action={
        canManage ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<LuPlus className="size-4" />}
            onClick={() => setAddOpen(true)}
            data-qa={`add-${type.toLowerCase()}-button`}
          >
            Add {label}
          </Button>
        ) : null
      }
    >
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No {label.toLowerCase()} options yet.
          {canManage ? ` Add the first ${label.toLowerCase()} for the project pickers.` : ''}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((opt) => (
            <li
              key={opt.id}
              className="flex items-center justify-between gap-4 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {type === 'BHK' ? `${opt.value} BHK` : opt.value}
                </span>
                <Badge variant="muted" data-qa={`option-${type.toLowerCase()}-unit-count`}>
                  {opt.unitCount} {opt.unitCount === 1 ? 'unit' : 'units'}
                </Badge>
              </div>
              {canManage ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${label.toLowerCase()} ${opt.value}`}
                    onClick={() => setDeleteTarget(opt)}
                    data-qa={`delete-${type.toLowerCase()}-button`}
                  >
                    <LuTrash2 className="size-4" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <ProjectOptionManageDialog
        type={type}
        projectId={projectId}
        open={addOpen}
        onOpenChange={setAddOpen}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        trigger={null}
        header={{
          title: `Delete ${label.toLowerCase()} "${deleteTarget?.value ?? ''}"?`,
          description:
            'This removes the option from the project pickers. It can only be deleted when no unit in this project uses it.',
        }}
        cancelButtonText="Cancel"
        confirmButtonText={deleteOption.isPending ? 'Deleting...' : 'Delete option'}
        confirmButtonProps={{
          variant: 'destructive',
          disabled: deleteOption.isPending,
        }}
        onConfirm={() => {
          if (deleteTarget === null || projectId === null) return;
          deleteOption.mutate(
            { id: deleteTarget.id, projectId },
            {
              onSuccess: () => setDeleteTarget(null),
              onError: (error) => {
                const msg = error instanceof Error ? error.message : 'Delete failed';
                toast.error(msg);
                setDeleteTarget(null);
              },
            },
          );
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}

/** Facing options card for the phases page grid. */
export function FacingOptionsCard({
  options,
  projectId,
  canManage,
}: {
  options: ProjectOptionRow[];
  projectId: string | null;
  canManage: boolean;
}) {
  const rows = options.filter((o) => o.type === 'FACING');
  return <OptionGroup type="FACING" rows={rows} projectId={projectId} canManage={canManage} />;
}

/** BHK options card for the phases page grid. */
export function BhkOptionsCard({
  options,
  projectId,
  canManage,
}: {
  options: ProjectOptionRow[];
  projectId: string | null;
  canManage: boolean;
}) {
  const rows = options.filter((o) => o.type === 'BHK');
  return <OptionGroup type="BHK" rows={rows} projectId={projectId} canManage={canManage} />;
}
