'use client';

// MilestonesDialog (portal redesign, 2026-11-09): ADMIN/OWNER edits the
// buyer-visible checkpoints of a project. The list is saved as a whole; the
// order here is the order the buyer reads. Mobile-first: one card per
// milestone, 44px controls, the dialog body scrolls under a pinned footer.
import { useEffect, useId, useRef, useState } from 'react';

import { Button, Dialog, IconButton, Input, toast } from '@paalstack/react-ui';
import { LuArrowDown, LuArrowUp, LuPlus, LuTrash2 } from '@paalstack/react-icons/lu';
import { MAX_MILESTONES_PER_PROJECT } from '@shadhil/api-types';

import { useProjectMilestones, useReplaceMilestones } from '@/hooks/queries/milestones';

import {
  draftsFromRows,
  moveDraft,
  newDraft,
  toPayload,
  validateDrafts,
  type MilestoneDraft,
} from './milestone-draft';

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
  const idBase = useId();

  // Seed from the server each time the dialog opens or fresh data lands.
  useEffect(() => {
    if (open && query.data !== undefined) setDrafts(draftsFromRows(query.data));
  }, [open, query.data]);

  const update = (key: string, patch: Partial<MilestoneDraft>) =>
    setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const problem = validateDrafts(drafts);

  function save() {
    if (problem !== null) {
      toast.error(problem);
      return;
    }
    replace.mutate(toPayload(drafts), {
      onSuccess: () => {
        toast.success('Milestones saved');
        onOpenChange(false);
      },
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not save milestones'),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      contentClassName="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-4rem)] overflow-hidden sm:max-w-lg"
      header={{
        title: 'Project milestones',
        description: 'Buyers see these on their portal, in this order. Mark one reached with a date.',
      }}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={replace.isPending}>
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
      <div className="-mx-1 min-h-0 space-y-3 overflow-y-auto overscroll-contain px-1" data-qa="milestones-editor">
        {query.isPending ? (
          <p className="text-muted-foreground text-sm" role="status">
            Loading milestones...
          </p>
        ) : query.isError ? (
          <div role="alert" className="text-destructive text-sm">
            Could not load milestones.{' '}
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
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
              {drafts.map((d, index) => {
                const base = `${idBase}-${d.key}`;
                return (
                  <li key={d.key} className="border-border space-y-2 rounded-lg border p-3" data-qa="milestone-row">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground w-5 shrink-0 text-sm tabular-nums">{index + 1}</span>
                      <Input
                        aria-label={`Milestone ${index + 1} name`}
                        placeholder="Slab cast"
                        maxLength={80}
                        value={d.name}
                        onChange={(e) => update(d.key, { name: e.target.value })}
                        className="min-h-11"
                      />
                      <IconButton
                        icon={<LuArrowUp className="size-4" />}
                        aria-label={`Move milestone ${index + 1} up`}
                        variant="ghost"
                        className="size-11 shrink-0"
                        disabled={index === 0}
                        onClick={() => setDrafts((l) => moveDraft(l, index, -1))}
                      />
                      <IconButton
                        icon={<LuArrowDown className="size-4" />}
                        aria-label={`Move milestone ${index + 1} down`}
                        variant="ghost"
                        className="size-11 shrink-0"
                        disabled={index === drafts.length - 1}
                        onClick={() => setDrafts((l) => moveDraft(l, index, 1))}
                      />
                      <IconButton
                        icon={<LuTrash2 className="size-4" />}
                        aria-label={`Remove milestone ${index + 1}`}
                        variant="ghost"
                        className="size-11 shrink-0"
                        onClick={() => setDrafts((l) => l.filter((x) => x.key !== d.key))}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label htmlFor={`${base}-target`} className="text-muted-foreground space-y-1 text-xs">
                        Target date
                        <Input
                          id={`${base}-target`}
                          type="date"
                          value={d.targetDay}
                          onChange={(e) => update(d.key, { targetDay: e.target.value })}
                          className="min-h-11"
                        />
                      </label>
                      <label htmlFor={`${base}-done`} className="text-muted-foreground space-y-1 text-xs">
                        Reached on (blank = not yet)
                        <Input
                          id={`${base}-done`}
                          type="date"
                          value={d.completedDay}
                          onChange={(e) => update(d.key, { completedDay: e.target.value })}
                          className="min-h-11"
                        />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ol>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
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
          </>
        )}
      </div>
    </Dialog>
  );
}
