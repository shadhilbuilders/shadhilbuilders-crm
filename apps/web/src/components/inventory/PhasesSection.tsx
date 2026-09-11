'use client';

// PhasesSection - the phases management list on the Inventory page.
//
// Shows the active project's phases (name + unit count). MANAGER/ADMIN/OWNER
// can add / rename / delete; other roles see the list read-only. Delete is
// a destructive action, so it opens an AlertDialog confirm first (user
// preference: never fire a destructive mutation on a button click).
import { useState } from 'react';

import {
  AlertDialog,
  Badge,
  Button,
  Card,
  toast,
} from '@paalstack/react-ui';
import { LuPencil, LuPlus, LuTrash2 } from '@paalstack/react-icons/lu';

import { useDeletePhase, type PhaseRow } from '@/hooks/queries/inventory';

import { PhaseManageDialog } from './PhaseManageDialog';

export function PhasesSection({
  phases,
  projectId,
  canManage,
}: {
  phases: PhaseRow[];
  projectId: string | null;
  canManage: boolean;
}) {
  const [manageTarget, setManageTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PhaseRow | null>(null);
  const deletePhase = useDeletePhase();

  return (
    <Card
      header={{ title: 'Phases' }}
      action={
        canManage ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<LuPlus className="size-4" />}
            onClick={() => {
              setManageTarget(null);
              setManageOpen(true);
            }}
            data-qa="add-phase-button"
          >
            Add phase
          </Button>
        ) : null
      }
    >
      {phases.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No phases yet.
          {canManage ? ' Add the first phase to start building inventory.' : ''}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {phases.map((phase) => (
            <li
              key={phase.id}
              className="flex items-center justify-between gap-4 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{phase.name}</span>
                <Badge variant="muted" data-qa="phase-unit-count">
                  {phase.unitCount} {phase.unitCount === 1 ? 'unit' : 'units'}
                </Badge>
              </div>
              {canManage ? (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Rename ${phase.name}`}
                    onClick={() => {
                      setManageTarget({ id: phase.id, name: phase.name });
                      setManageOpen(true);
                    }}
                    data-qa="edit-phase-button"
                  >
                    <LuPencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${phase.name}`}
                    onClick={() => setDeleteTarget(phase)}
                    data-qa="delete-phase-button"
                  >
                    <LuTrash2 className="size-4" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <PhaseManageDialog
        phase={manageTarget}
        projectId={projectId}
        open={manageOpen}
        onOpenChange={(open) => {
          setManageOpen(open);
          if (!open) setManageTarget(null);
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        trigger={null}
        header={{
          title: `Delete phase ${deleteTarget?.name ?? ''}?`,
          description:
            'This permanently removes the phase. It can only be deleted when it has no units.',
        }}
        cancelButtonText="Cancel"
        confirmButtonText={deletePhase.isPending ? 'Deleting...' : 'Delete phase'}
        confirmButtonProps={{
          variant: 'destructive',
          disabled: deletePhase.isPending,
        }}
        onConfirm={() => {
          if (deleteTarget === null) return;
          deletePhase.mutate(deleteTarget.id, {
            onSuccess: () => {
              setDeleteTarget(null);
            },
            onError: (error) => {
              const msg = error instanceof Error ? error.message : 'Delete failed';
              toast.error(msg);
              setDeleteTarget(null);
            },
          });
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
