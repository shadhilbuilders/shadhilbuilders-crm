'use client';

// MilestonesDialog (portal redesign, 2026-11-09): ADMIN/OWNER edits the
// buyer-visible checkpoints of a project. The list is saved as a whole; the
// order here is the order the buyer reads. Mobile-first: one card per
// milestone, 36px controls, the dialog body scrolls under a pinned footer.
import { useEffect, useRef, useState } from 'react';

import { AlertDialog, Button, Dialog, toast } from '@paalstack/react-ui';
import { LuPlus } from '@paalstack/react-icons/lu';
import { MAX_MILESTONES_PER_PROJECT, type ProjectMilestoneRow } from '@shadhil/api-types';

import { useProjectMilestones, useReplaceMilestones } from '@/hooks/queries/milestones';

import {
  draftsFromRows,
  emptyConfirmCopy,
  isUntouched,
  moveDraft,
  newDraft,
  toPayload,
  validateDrafts,
  warnDrafts,
  type MilestoneDraft,
} from './milestone-draft';
import { MilestoneRow } from './milestone-row';

export type MilestonesDialogProps = {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function MilestonesDialog({ projectId, open, onOpenChange }: MilestonesDialogProps) {
  const query = useProjectMilestones(open ? projectId : null);
  const replace = useReplaceMilestones(projectId);
  const [drafts, setDrafts] = useState<MilestoneDraft[]>([]);
  const counter = useRef(0);

  // The rows the editor was last seeded from, and the live drafts, held in refs
  // so the seeding effect can compare them without re-running on every keystroke.
  const seededFrom = useRef<readonly ProjectMilestoneRow[] | null>(null);
  const draftsRef = useRef<MilestoneDraft[]>(drafts);
  // Synced in an effect, not during render. Declared BEFORE the seeding effect so
  // the seeding effect always reads the committed drafts.
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  // Seed from the server when the dialog opens. A refetch while open refreshes
  // the list only if the admin has not touched it; once they have typed, their
  // edits win (saving still replaces the server list, as before).
  useEffect(() => {
    if (!open) {
      seededFrom.current = null;
      return;
    }
    const rows = query.data;
    if (rows === undefined) return;
    const prior = seededFrom.current;
    if (prior === null || isUntouched(draftsRef.current, prior)) {
      seededFrom.current = rows;
      setDrafts(draftsFromRows(rows));
    }
  }, [open, query.data]);

  const update = (key: string, patch: Partial<MilestoneDraft>) =>
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const problem = validateDrafts(drafts);
  const warning = warnDrafts(drafts);
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  // What the buyer currently sees, as opposed to what the editor holds.
  const savedCount = query.data?.length ?? 0;
  const emptyCopy = emptyConfirmCopy(savedCount);

  function persist() {
    replace.mutate(toPayload(drafts), {
      onSuccess: () => {
        toast.success('Milestones saved');
        onOpenChange(false);
      },
      onError: (error) =>
        toast.error(error instanceof Error ? error.message : 'Could not save milestones'),
    });
  }

  function save() {
    if (problem !== null) {
      toast.error(problem);
      return;
    }
    // Saving an empty list deletes every milestone the buyer can see. One PUT,
    // no undo, so ask first rather than relying on the audit row afterwards.
    if (drafts.length === 0 && savedCount > 0) {
      setConfirmEmpty(true);
      return;
    }
    persist();
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-4rem)] overflow-hidden sm:max-w-lg"
        header={{
          title: 'Project milestones',
          description:
            'Buyers see these on their portal, in this order. Mark one reached with a date.',
        }}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={replace.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={save}
              isLoading={replace.isPending}
              loadingText="Saving..."
              data-qa="milestones-save"
            >
              Save milestones
            </Button>
          </div>
        }
      >
        <div
          className="-mx-1 min-h-0 space-y-3 overflow-y-auto overscroll-contain px-1"
          data-qa="milestones-editor"
        >
          {query.isPending ? (
            <p className="text-muted-foreground text-sm" role="status">
              Loading milestones...
            </p>
          ) : query.isError ? (
            <div role="alert" className="text-destructive text-sm">
              Could not load milestones.{' '}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
            </div>
          ) : (
            <>
              {drafts.length === 0 ? (
                <p className="text-muted-foreground text-sm" data-qa="milestones-empty">
                  No milestones yet. Add the first checkpoint buyers should look forward to.
                </p>
              ) : null}
              <ol className="space-y-3">
                {drafts.map((d, index) => (
                  <MilestoneRow
                    key={d.key}
                    draft={d}
                    index={index}
                    isFirst={index === 0}
                    isLast={index === drafts.length - 1}
                    onChange={(patch) => update(d.key, patch)}
                    onMoveUp={() => setDrafts((l) => moveDraft(l, index, -1))}
                    onMoveDown={() => setDrafts((l) => moveDraft(l, index, 1))}
                    onRemove={() => setDrafts((l) => l.filter((x) => x.key !== d.key))}
                  />
                ))}
              </ol>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                leftIcon={<LuPlus className="size-4" />}
                disabled={drafts.length >= MAX_MILESTONES_PER_PROJECT}
                onClick={() => {
                  counter.current += 1;
                  setDrafts((l) => [...l, newDraft(`new-${counter.current}`)]);
                }}
                data-qa="milestone-add"
              >
                Add milestone
              </Button>
              {problem !== null && drafts.length > 0 ? (
                <p className="text-destructive text-sm" role="alert">
                  {problem}
                </p>
              ) : null}
              {warning !== null && problem === null ? (
                <p className="text-muted-foreground text-sm" data-qa="milestones-warning">
                  {warning}
                </p>
              ) : null}
            </>
          )}
        </div>
      </Dialog>

      <AlertDialog
        open={confirmEmpty}
        onOpenChange={setConfirmEmpty}
        header={{
          title: emptyCopy.title,
          description: emptyCopy.description,
        }}
        cancelButtonText="Keep editing"
        confirmButtonText={emptyCopy.confirmLabel}
        confirmButtonProps={{ 'data-qa': 'milestones-confirm-empty' }}
        onConfirm={() => {
          setConfirmEmpty(false);
          persist();
        }}
      />
    </>
  );
}
