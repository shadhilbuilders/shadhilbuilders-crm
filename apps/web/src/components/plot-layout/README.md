# Plot layout (interactive site plan)

Interactive availability map for the approved CMDA layout in
`docs/CMDA LAYOUT.pdf`. Every numbered plot on the drawing is a real SVG hit
area: click it to see its details, hover for a tooltip, search by number,
filter by category or status, zoom and pan.

## Where things live

```
apps/web/src/components/plot-layout/
  PlotLayout.tsx         orchestrator: selection, filters, load states
  PlotMap.tsx            <svg> viewport, pan/zoom, tooltip, keyboard nav
  PlotPolygon.tsx        one plot's clickable shape
  PlotDetails.tsx        details panel for the selected plot
  PlotLegend.tsx         colour key + match counts
  PlotSearch.tsx         plot-number search, category and status filters
  plot-types.ts          PlotStatus / PlotCategory / Plot / PlotGeometry
  plot-geometry.ts       GENERATED - 125 traced polygons (do not hand-edit)
  plot-colors.ts         getPlotColor() - the only status -> colour map
  plot-shapes.ts         polygon centroid / bounds helpers
  plot-navigation.ts     arrow-key neighbour search
  plot-format.ts         feet/inches and metre formatting
  plot-data.ts           buildPlots(): geometry + availability merge
apps/web/public/cmda-plan.svg          vector background of the site plan
scripts/extract-cmda-layout.py         regenerates the two files above
```

Route: `/{orgSlug}/projects/{projectSlug}/plots`.

## The map sheet colour, the status fills, and the plot number

The status fill is OPAQUE, and each plot carries its number on top of it, in
a colour that reads against that particular fill. The three facts belong
together:

| status    | fill     | number  | meaning                              |
| --------- | -------- | ------- | ------------------------------------ |
| available | `#15803D` green | white | free to sell                |
| blocked   | `#E3C563` gold  | dark  | held, not gone           |
| booked    | `#DC2626` red   | white | sold, gone                |
| selected  | `#2563EB` blue  | white | the plot the panel is showing |

`PLOT_STATUS_FILL` in `plot-colors.ts` is the only place those live. The map
fill, the legend swatch, the hover tooltip's dot and the details panel's badge
all read from it, so they cannot disagree.

**Why blocked is gold and not orange.** The brief asked for orange, and orange
was the first implementation. It does not work: orange-600 (`#EA580C`) and
red-600 (`#DC2626`) are adjacent hues in the same ramp, and they are not
distinguishable in practice. Measured:

- CIE dE76 between them is 23.3, in the "noticeable" band, not "clearly
  different" (>25). On the map they read as the same colour, which is what was
  reported.
- Under deuteranopia the gap collapses to dE 5.7. Both render as the same
  olive, so a red-green colourblind user cannot tell booked from blocked at
  all.
- White text on orange is 3.56:1, which fails WCAG AA.

Gold is dE 75.5 from the red in normal vision and dE 27.7 worst-case across
normal vision, deuteranopia, protanopia and tritanopia.

**Why the number colour is per-status.** The fills are opaque, so the number
sits on a coloured field and must contrast with THAT field. White works on the
dark green and red, but a gold fill carries white at only 1.69:1, so the gold
carries a dark ink instead. This is the same rule the app's own design system
uses: its `warning` token pairs an amber background with a dark foreground.

**Why available is green-700, not green-600.** `#16A34A` carries white text at
3.30:1, which fails AA. `#15803D` carries it at 5.02:1, and the two are a
barely perceptible step apart - the same hue, one step darker.

Every fill and its number clear WCAG AA's 4.5:1 for small text: available
5.02:1, booked 4.83:1, blocked 8.69:1, selected 5.17:1.

**Why the fill is opaque.** The plot number has to read against the fill, and
a number on a translucent fill is unreadable over whatever the drawing shows
through.

**Why the number is drawn by us.** The approved drawing prints each plot number
inside its own polygon, and the opaque fill covers it. The number is re-drawn
at the polygon's area centroid in white, at the plan's own typeface size
(font-size 6.2), which is where the drawing puts it: the traced centroid is
within 0.15 plan units of the printed label's visual centre.

**A dimmed plot gets no number.** A plot excluded by the active filter stays
translucent and unlabelled, so a filtered-out plot never reads as a live,
sellable plot.

## Selection toggles

Clicking a plot selects it; clicking the SAME plot again deselects it. The
toggle lives in `PlotLayout` (`toggleSelect`), in the one place that owns the
selection state, because the map's gesture handler and the polygon's `onClick`
are two paths to that state.

Measured: a real mouse click fires `onSelect` exactly ONCE. The map takes
pointer capture on the `<svg>`, so `pointerup` and `click` are delivered to the
svg rather than to the polygon - the polygon's `onClick` does not also run. A
toggle would cancel itself out if both paths fired.

The arrow-key cursor does NOT toggle. It moves the selection, so it uses
`onSelectWithoutToggle`; pressing an arrow at the edge of the layout keeps the
same plot selected instead of deselecting it.

Search and the filter chips do NOT toggle either. Asking for the plot you are
already looking at must not empty the details panel.

## Two inputs, one join

The map is geometry plus availability, and they arrive from different places on
purpose:

| Half         | Source                     | Changes when                     |
| ------------ | -------------------------- | -------------------------------- |
| 125 polygons | `plot-geometry.ts`         | the approved drawing changes     |
| plot status  | `GET /api/inventory/plots` | a unit is sold, held or released |

`buildPlots(PLOT_GEOMETRY, rows)` joins them by plot number. Because the
geometry is never rebuilt from the API, a status change repaints the map without
a coordinate moving.

Availability is read through `usePlotStatuses` in
`src/hooks/queries/inventory.ts`, which follows the same shape as the
`useInventoryUnits` / `useInventoryPhases` hooks beside it. A booking approval
invalidates it along with units and phases, so the map cannot keep showing a
sold plot as available.

## How a unit becomes a plot

There is no `Plot` table. A plot exists when a **unit's number IS a plot
number**:

- `"37"` → plot 37
- `"D-101"`, `"A-12"`, `"Villa 3"`, `"037"`, `"0"`, `"126"` → not a plot

The rule lives in one place, `packages/api-types/src/plot-status.ts`
(`parsePlotNumber`), and the backend narrows its query with the same canonical
spellings (`PLOT_NUMBER_STRINGS`) so the filter and the parser cannot disagree.
Two phases of one project may both hold a unit `"37"`; the most binding claim
wins (`booked` > `blocked` > `available`), so a sold plot never reads available.

An empty result is a **normal answer**, not a failure: it means nothing in the
project is plot-numbered yet, so every plot reads available. The page says
exactly that instead of showing an unexplained all-grey plan. Today that is the
real state - the dev database has no units at all.

Status mapping (`plotStatusFromUnitStatus`):

| `UnitStatus` | `PlotStatus` |
| ------------ | ------------ |
| `AVAILABLE`  | `available`  |
| `SOLD`       | `booked`     |
| `HOLD`       | `blocked`    |
| `TOKEN`      | `blocked`    |

An unrecognised status throws rather than defaulting to available: a silent
default would make every surface wrong at once.

## API contract

```
GET /api/inventory/plots?projectId=<id>     -> PlotStatusListResult
```

```json
{ "rows": [{ "plotNumber": 20, "status": "booked" }] }
```

Defined in `packages/api-types/src/plot-status.ts`. The browser reaches it
through the existing BFF at `/api/bff/inventory/plots`, so auth and JWT minting
are unchanged, and the service reads through `withRlsContext` per repo
convention.

## Plot pricing

`Plot.price` is optional and currently never set: the layout drawing states no
price and no plot price is recorded yet. The details panel renders "Not set"
rather than a zero. Populate it from the API when plot pricing exists.

## Booking is not here

This surface is read-only. A click selects; it never reserves. Booking belongs
in the bookings module, which must validate availability and reject a second
concurrent booking inside one transaction.

## Regenerating the traced geometry

If the approved drawing changes, re-run the extraction rather than editing
coordinates by hand:

```bash
python3 -m pip install pymupdf shapely
python3 scripts/extract-cmda-layout.py
```

The script prints its own verification: how many plot numbers mapped to a
distinct polygon, the summed plot area against the drawing's area statement,
and the percentage of each polygon's perimeter that lies on drawn ink.

## The EWS area figure on the drawing is wrong - do not surface it

The drawing's own quantity schedule states **"E.W.S. PROVIDED : 1265 SQ.M"** for
"E.W.S PLOTS (114 TO 125) : 12 Nos." That figure is not the sum of those twelve
plots, and the difference is large enough to matter.

Measured: the 12 EWS plots total **795.6 m²** on the trace, 56.0-71.8 m² each
(mean 66.3). 1265 m² would require **105.4 m² per plot**. The drawing's own
printed dimensions contradict that - plot 117 prints 30' x 24' (66.9 m²), 124
prints 35.75' x 20.75' (68.9 m²), 125 prints 37.25' x 20' (69.2 m²). Every EWS
plot that prints both dimensions lands at ~69 m², matching the trace.

The trace is not the outlier here. Two independent checks back it:

- Across the 65 plots that print both dimensions, the printed `width x length`
  sums to 5610.4 m² against 5801.5 m² traced (ratio 1.034; the traced figure is a
  bounding rectangle, so >= 1 is expected). The trace agrees with the drawing's
  own printed numbers, not merely with its total.
- The drawing's schedule is otherwise internally exact: OSR 1269 = parks 360 +
  909; public purpose 133 = 66 + 67; total extent 17775 = plottable 12421 + road 5354. So the schedule is reliable arithmetic - which makes 1265 a genuine
  outlier rather than a rounding convention. It is also suspiciously close to
  the OSR figure of 1269.

**Consequences.** The drawing asserts "10% E.W.S. REQUIRED : 1242 SQ.M" and then
claims to provide 1265. Measured against the plottable area of 12421 m², the
twelve EWS plots are 795.6 m², or 6.4% - below the 10% the drawing itself cites.
That is a planning question about the layout's approval, not a software one, and
it needs an answer from whoever owns the drawing.

**What this codebase does about it.** Nothing is displayed from that figure.
Per-plot areas come from the trace, and the details panel labels them "measured
from the approved layout drawing". Geometry is left exactly as traced: changing
it to reach 1265 would be inventing boundaries, and the trace is the side with
the evidence. If the EWS reservation genuinely includes land beyond the plot
boundaries, the drawing does not label any such area, so there is nothing
defensible to trace.
