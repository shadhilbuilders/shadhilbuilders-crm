// The CMDA layout's plot numbers - the bounds and the schema, in one place.
//
// WHY THIS IS ITS OWN MODULE: `UnitRowSchema` (inventory.ts) needs to validate a
// unit's plot number, and the plot map's row schema (plot-status.ts) embeds the
// unit row. Putting the plot number in either of those makes the other import it
// back, and a cycle leaves one of the two schemas as `undefined` at module init
// - which fails as `Cannot read properties of undefined (reading 'nullable')`
// the moment the row is parsed. A leaf module with no imports but zod breaks the
// cycle and keeps ONE definition of the layout's range.

import { z } from 'zod';

/** Plot numbers on the approved CMDA layout. */
export const MIN_PLOT_NUMBER = 1;
export const MAX_PLOT_NUMBER = 125;

/**
 * A plot number, as the unit DTOs and forms accept it.
 *
 * The bounds live beside the layout they describe: the traced geometry defines
 * 125 plots, so a number outside that range would join to no polygon and quietly
 * disappear from the map. "No plot assigned" is expressed as `.nullable()` at
 * the call site, never as a sentinel like 0.
 */
export const PlotNumberSchema = z.number().int().min(MIN_PLOT_NUMBER).max(MAX_PLOT_NUMBER);
export type PlotNumber = z.infer<typeof PlotNumberSchema>;
