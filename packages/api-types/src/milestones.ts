// Project milestones (portal redesign, 2026-11-09): buyer-visible checkpoints
// staff set per project ("Slab cast", "Handover"). The list is REPLACED as a
// whole by one PUT so the order the admin sees is the order the buyer sees.
import { z } from 'zod';

export const MAX_MILESTONES_PER_PROJECT = 30;

export const ProjectMilestoneRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  targetDate: z.iso.datetime({ offset: true }).nullable(),
  /** Null until staff mark the milestone reached. */
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ProjectMilestoneRow = z.infer<typeof ProjectMilestoneRowSchema>;

export const MilestoneInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the milestone.').max(80),
    targetDate: z.iso.datetime({ offset: true }).nullable().optional(),
    completedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
export type MilestoneInput = z.infer<typeof MilestoneInputSchema>;

/** PUT /api/milestones/:projectId body. An empty list clears every milestone. */
export const ReplaceMilestonesDtoSchema = z
  .object({
    milestones: z.array(MilestoneInputSchema).max(MAX_MILESTONES_PER_PROJECT),
  })
  .strict();
export type ReplaceMilestonesDto = z.infer<typeof ReplaceMilestonesDtoSchema>;
