// ────────────────────────────────────────────────────────────────────────────
// Shadhil CRM - Lead fact ledger DTOs (Zod)
// ────────────────────────────────────────────────────────────────────────────
// T-LEAD-FACTS (2026-11-05). A producer reports an OBSERVATION (field, value,
// evidence); the server prices it and decides whether it fills the Lead column
// or waits as a suggestion. No client ever sends a band or a score - see
// apps/backend/src/leads/lead-evidence.ts for why.
// ────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/** Which Lead columns a fact may name. Mirrors LEAD_FACT_FIELDS. */
export const LeadFactFieldSchema = z.enum(['name', 'email', 'source']);
export type LeadFactField = z.infer<typeof LeadFactFieldSchema>;

export const FactBandSchema = z.enum(['VERIFIED', 'PROBABLE', 'POSSIBLE']);
export type FactBand = z.infer<typeof FactBandSchema>;

export const FactStatusSchema = z.enum(['APPLIED', 'PROPOSED', 'DISMISSED', 'SUPERSEDED']);
export type FactStatus = z.infer<typeof FactStatusSchema>;

/**
 * How the claim was observed. The server owns the weights; this list exists so
 * the client can send a kind and can render a tooltip. Adding a kind means
 * adding it to EVIDENCE_WEIGHTS in the same change.
 */
export const EvidenceKindSchema = z.enum([
  'lead.reply-from-number',
  'enquiry.form-email',
  'booking.contact-match',
  'site-visit.signin',
  'call.note-mentions',
  'whatsapp.message-mentions',
  'whatsapp.profile-name',
  'handle.name-form',
  'contradiction',
]);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const LeadEvidenceSchema = z.object({
  kind: EvidenceKindSchema,
  /**
   * Read by a rep in a tooltip. Write it for them: "their signature on 14 July
   * reads 'Head of Security, Acme'", never "signature match confirmed".
   */
  detail: z.string().trim().min(1).max(500),
  sourceUrl: z.url().max(500).optional(),
});
export type LeadEvidence = z.infer<typeof LeadEvidenceSchema>;

export const RecordLeadFactDtoSchema = z.object({
  field: LeadFactFieldSchema,
  value: z.string().trim().min(1).max(254),
  /** One entry per INDEPENDENT source. Two details on one page are one entry. */
  evidence: z.array(LeadEvidenceSchema).min(1).max(6),
  /** Who observed it: 'whatsapp.profile-name', 'enquiry-form', 'telecaller-note'. */
  method: z.string().trim().min(1).max(80),
  sourceUrl: z.url().max(500).optional(),
});
export type RecordLeadFactDto = z.infer<typeof RecordLeadFactDtoSchema>;

export const DecideLeadFactDtoSchema = z.object({
  decision: z.enum(['ACCEPT', 'DISMISS']),
  reason: z.string().trim().max(500).optional(),
});
export type DecideLeadFactDto = z.infer<typeof DecideLeadFactDtoSchema>;

/** Wire shape of one ledger row. `rationale` is derived, never stored. */
export type LeadFactRow = {
  id: string;
  leadId: string;
  field: LeadFactField;
  value: string;
  score: number;
  band: FactBand;
  status: FactStatus;
  /** Why it is believed, in the rep's language. */
  rationale: string;
  evidence: LeadEvidence[];
  method: string;
  sourceUrl: string | null;
  observedAt: string;
  decidedById: string | null;
  decidedAt: string | null;
};

export type LeadFactsResponse = {
  leadId: string;
  /** The values currently on the Lead row, so the UI can show the difference. */
  values: Record<LeadFactField, string | null>;
  /** APPLIED + PROPOSED, newest first. Dismissed and superseded are history. */
  facts: LeadFactRow[];
};

export type RecordLeadFactResult = {
  /** False when the claim was refused or was a no-op. */
  stored: boolean;
  /** True when the Lead column was written. */
  applied: boolean;
  band: FactBand | null;
  score: number;
  rationale: string;
  /** Present whenever nothing was written, in the rep's language. */
  reason?: string;
  fact?: LeadFactRow;
};
