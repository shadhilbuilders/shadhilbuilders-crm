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
