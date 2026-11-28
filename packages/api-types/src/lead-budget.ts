// ────────────────────────────────────────────────────────────────────────────
// Lead budget bands (single source of truth for the wire format)
// ────────────────────────────────────────────────────────────────────────────
// T-LEAD-BUDGET (2026-11-27). `Lead.budget` is a Postgres enum; this is the same
// closed set on the API side, so a typo'd band is a 400 at the edge instead of a
// 500 from Prisma, and the web layer labels each value from this list rather
// than from a second copy.
//
// The bands match how Indian residential pricing is quoted out loud: under 50
// lakh, 50 lakh to 1 crore, and so on. They are deliberately coarse. A "2.4 Cr"
// only exists in conversation; what the org reports on is which band a buyer
// sits in.
import { z } from 'zod';

export const LEAD_BUDGET_BANDS = [
  'UNDER_50L',
  'FROM_50L_TO_1CR',
  'FROM_1CR_TO_2CR',
  'FROM_2CR_TO_5CR',
  'ABOVE_5CR',
  'NOT_DECIDED',
] as const;

export const LeadBudgetBandSchema = z.enum(LEAD_BUDGET_BANDS);
export type LeadBudgetBand = z.infer<typeof LeadBudgetBandSchema>;
