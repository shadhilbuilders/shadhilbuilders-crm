// Formatting helpers for plot measurements.
//
// The drawing prints plot sides in feet and inches ("44'7.5\"") and the site
// area statement in square metres. Both units are shown in the UI so a user
// with the approved plan in hand can check a figure against it without doing
// arithmetic.

const FEET_PER_METRE = 3.280839895;

/** `44.625` -> `44'7.5"`. Rounds to the nearest half inch, the plan's precision. */
export function feetToFeetInches(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '-';
  const totalInches = Math.round(value * 24) / 2; // nearest 0.5"
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches - feet * 12;
  if (inches === 0) return `${feet}'`;
  const rendered = Number.isInteger(inches) ? `${inches}` : inches.toFixed(1);
  return `${feet}'${rendered}"`;
}

export function feetToMetres(feet: number): number {
  return feet / FEET_PER_METRE;
}

export function metresToFeet(metres: number): number {
  return metres * FEET_PER_METRE;
}

/** One decimal place, e.g. `95.2`. */
export function formatSqM(value: number): string {
  return value.toFixed(1);
}

/** `6.9 m x 13.6 m` from the measured feet extents. */
export function formatSizeBothUnits(widthFt: number, lengthFt: number): string {
  const wM = feetToMetres(widthFt);
  const lM = feetToMetres(lengthFt);
  return `${feetToFeetInches(widthFt)} x ${feetToFeetInches(lengthFt)} (${wM.toFixed(1)} m x ${lM.toFixed(1)} m)`;
}
