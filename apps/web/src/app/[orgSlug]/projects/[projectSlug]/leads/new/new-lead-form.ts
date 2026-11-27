// Schema and payload for the create-lead form, lifted out of page.tsx so the
// empty-picker case can be tested without mounting the props-API Form.
//
// THE BUG THIS FILE EXISTS FOR (2026-11-24): the Form library's `select` and
// `combobox` adapters store `value || undefined`, so an option whose value is
// the empty string - which is how this form says "let the backend decide" -
// lands in react-hook-form as `undefined`, not `''`. The schema declared
// `teamId: z.string()` and `assignedOwnerId: z.string()`, so picking
// "Auto-assign (rule engine)" answered "Invalid input: expected string,
// received undefined" before a request was ever made. Picking "Default (first
// team)" on a multi-team manager's Team select had the same failure.
//
// So: the schema accepts the three shapes a picker can actually produce (a
// value, the empty sentinel, or undefined), and the payload builder keys off
// truthiness rather than comparing against the sentinel. An id is never empty,
// so truthiness is the right test for "the user chose nothing".
import { z } from 'zod';

import { LEAD_SOURCES } from '@/lib/labels';
import {
  DEFAULT_PHONE_COUNTRY,
  PhoneCountrySchema,
  PhoneInputSchema,
  refinePhonePair,
} from '@/lib/phone';

/** "Let the backend pick the team" - an empty string is never a valid id. */
export const NO_TEAM_OVERRIDE = '';
/** "Let the assignment rule pick the owner", same shape as NO_TEAM_OVERRIDE. */
export const NO_OWNER_OVERRIDE = '';

/**
 * One picker's value: a real id, the empty sentinel, or undefined (what the
 * Form library hands react-hook-form for an empty-valued option).
 */
const pickerValue = () => z.union([z.literal(''), z.string().min(1)]).optional();

export const createLeadSchema = z
  .object({
    // trim BEFORE min: with `min(1).trim()`, a name of three spaces cleared the
    // length check and only the payload builder's own trim emptied it, so a
    // whitespace-only name reached the wire.
    name: z.string().trim().min(1, 'Name is required').max(120),
    // VALIDATE-ONLY, NORMALIZE-ON-SUBMIT (2026-11-19). This used to be
    // `PhoneSchema`, whose TRANSFORM rewrites the value to `91XXXXXXXXXX`.
    // That is fine for a submit payload but wrong for a live-validated field:
    // the resolver's transformed output is what RHF would feed back on
    // revalidation, so the input could rewrite itself from 10 digits to 12
    // while the user was still typing. `PhoneInputSchema` applies the identical
    // rule with no transform, and the payload builder calls the same
    // normalisation `PhoneSchema` used.
    phone: PhoneInputSchema,
    // The country the digits were typed in. It travels with the number: the
    // server parses `phone` in `phoneCountry` (a bare national number is refused
    // rather than guessed), so the two are always written together.
    phoneCountry: PhoneCountrySchema.optional(),
    // Email is optional. The form defaults it to '' - but `.optional()` only
    // allows undefined/missing, not ''. So accept '' as "not provided".
    email: z.union([z.literal(''), z.email().trim().toLowerCase().max(254)]).optional(),
    source: z.enum(LEAD_SOURCES),
    notes: z.string().max(2000, 'Notes must be less than 2000 characters').trim().optional(),
    // Only rendered for a MANAGER who leads more than one team.
    teamId: pickerValue(),
    // Only rendered for MANAGER/ADMIN/OWNER, and only when staff are assignable.
    assignedOwnerId: pickerValue(),
  })
  // The country rule (2026-11-27): a lead cannot be created without a phone it
  // can be messaged on, so the field is required AND checked against the
  // country on the trigger. Both used to be the API's job, the second one as a
  // toast; now they report under the field on the first Save.
  .superRefine((values, ctx) => refinePhonePair(values, ctx, { required: true }));

export type CreateLeadSchema = z.infer<typeof createLeadSchema>;

/** The wire body for POST /api/leads, with every "nothing chosen" key omitted. */
export interface CreateLeadPayload {
  name: string;
  phone: string;
  phoneCountry: string;
  projectId: string;
  email?: string;
  source: string;
  notes?: string;
  teamId?: string;
  assignedOwnerId?: string;
}

export function buildLeadPayload(values: CreateLeadSchema, projectId: string): CreateLeadPayload {
  const email = values.email?.trim().toLowerCase() ?? '';
  const notes = values.notes?.trim() ?? '';
  return {
    name: values.name.trim().replace(/\s+/g, ' '),
    phone: values.phone,
    phoneCountry: values.phoneCountry ?? DEFAULT_PHONE_COUNTRY,
    projectId,
    ...(email.length > 0 ? { email } : {}),
    source: values.source.trim(),
    ...(notes.length > 0 ? { notes } : {}),
    // Truthiness, not `!== NO_TEAM_OVERRIDE`: an empty picker arrives as
    // undefined, and `undefined !== ''` is true, which is how an explicit
    // `teamId: undefined` used to reach the DTO and fail its parse.
    ...(values.teamId ? { teamId: values.teamId } : {}),
    ...(values.assignedOwnerId ? { assignedOwnerId: values.assignedOwnerId } : {}),
  };
}
