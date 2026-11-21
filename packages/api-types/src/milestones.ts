// Project milestones (portal redesign, 2026-11-09): buyer-visible checkpoints
// staff set per project ("Slab cast", "Handover"). The list is REPLACED as a
// whole by one PUT so the order the admin sees is the order the buyer sees.
import { z } from 'zod';

export const MAX_MILESTONES_PER_PROJECT = 30;

/**
 * A milestone may be marked reached "today" by a user anywhere on the planet.
 * The editor sends UTC midnight of the chosen calendar day, so an IST user at
 * 03:00 local has a completion date about 2.5h in the future. One day of slack
 * keeps "mark today reached" working everywhere while still rejecting a date
 * typed into next month.
 */
export const COMPLETED_AT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Trim, collapse inner whitespace, lowercase: the comparison key, not a rewrite. */
const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Second occurrence of a repeated name, or null. Exported because the editor and
 * the DTO must apply the SAME rule: a client-only check lets a crafted request
 * through, and a server-only check tells the user after they already hit Save.
 */
export function findDuplicateMilestoneName(
  names: readonly string[],
): { index: number; name: string } | null {
  const seen = new Set<string>();
  for (let i = 0; i < names.length; i += 1) {
    const raw = names[i] ?? '';
    const key = nameKey(raw);
    if (key.length === 0) continue;
    if (seen.has(key)) return { index: i, name: raw.trim() };
    seen.add(key);
  }
  return null;
}

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
  .strict()
  .superRefine((milestone, ctx) => {
    if (!milestone.completedAt) return;
    const completed = new Date(milestone.completedAt).getTime();
    if (completed > Date.now() + COMPLETED_AT_FUTURE_TOLERANCE_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'A milestone cannot be marked reached with a future date.',
      });
    }
  });
export type MilestoneInput = z.infer<typeof MilestoneInputSchema>;

/** PUT /api/milestones/:projectId body. An empty list clears every milestone. */
export const ReplaceMilestonesDtoSchema = z
  .object({
    milestones: z.array(MilestoneInputSchema).max(MAX_MILESTONES_PER_PROJECT),
  })
  .strict()
  .superRefine((dto, ctx) => {
    const duplicate = findDuplicateMilestoneName(dto.milestones.map((m) => m.name));
    if (duplicate === null) return;
    ctx.addIssue({
      code: 'custom',
      path: ['milestones', duplicate.index, 'name'],
      message: `Two milestones are both named "${duplicate.name}". Give them different names so buyers can tell them apart.`,
    });
  });
export type ReplaceMilestonesDto = z.infer<typeof ReplaceMilestonesDtoSchema>;
