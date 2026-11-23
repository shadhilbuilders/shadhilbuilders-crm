// How a villa is named to a buyer (owner decision 2026-11-23: the plot number
// travels WITH the villa, not as its own template slot).
//
// WHY NOT A SEPARATE SLOT: `Unit.plotNumber` is nullable - a villa can be entered
// before anybody places it on the layout - and a template parameter can never be
// omitted. A "plot {{n}}" slot would therefore have to print "plot " or "plot
// undefined" for those villas. Folding the plot into the villa's own value keeps
// one approved template valid for both cases, and changes no template at all when
// the wording needs to move.

/**
 * `A-101 (plot 37)`, or just `A-101` when no plot is set.
 *
 * The plot is in brackets on purpose: the door number is what the buyer says on
 * the phone ("villa A-101"), and the plot is the layout reference that helps them
 * place it on the site map. Neither reads as the other.
 */
export function villaLabel(unitNumber: string, plotNumber: number | null | undefined): string {
  if (plotNumber === null || plotNumber === undefined) return unitNumber;
  if (!Number.isFinite(plotNumber)) return unitNumber;
  return `${unitNumber} (plot ${plotNumber})`;
}
