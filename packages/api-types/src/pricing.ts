// ────────────────────────────────────────────────────────────────────────────
// Unit pricing math - ONE implementation shared by the NestJS services and the
// Next forms, so the figure a user sees while typing is the figure the server
// stores.
//
//   unit total        = buildup sq.ft x price per sq.ft
//   negotiated total  = buildup sq.ft x negotiated rate per sq.ft
//
// Money is multiplied in integer hundredths (BigInt) and rounded half-up to 2
// decimals. Plain float math drifts (e.g. 1050.1 * 3999.99) and the product can
// exceed 2^53 once both operands are scaled, hence BigInt.
// ────────────────────────────────────────────────────────────────────────────

/** Caps mirrored by the DTOs. */
export const MAX_SQFT = 100_000;
export const MAX_RATE_PER_SQFT = 10_000_000;
export const MAX_UNIT_TOTAL = 100_000_000_00;
/** Booking total cap (matches the existing amount cap, INR 100 Cr). */
export const MAX_BOOKING_TOTAL = 1_000_000_000;

type Numeric = number | string | null | undefined;

function toHundredths(value: Numeric): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 100));
}

/**
 * area x rate rounded half-up to 2 decimals, as a number. Returns null when
 * either input is missing, non-numeric or not positive - never 0 or NaN, so a
 * caller cannot silently persist a bogus total.
 */
export function computeAreaTotal(area: Numeric, rate: Numeric): number | null {
  const a = toHundredths(area);
  const r = toHundredths(rate);
  if (a === null || r === null) return null;
  // a and r are hundredths, so a*r is in 1e-4 units; /100 brings it back to
  // hundredths, and +50 makes the integer division round half-up.
  const hundredths = (a * r + 50n) / 100n;
  return Number(hundredths) / 100;
}

/** Unit total = buildup sq.ft x price per sq.ft. */
export const computeUnitTotal = computeAreaTotal;

/** Negotiated total = buildup sq.ft x negotiated rate per sq.ft. */
export const computeNegotiatedTotal = computeAreaTotal;
