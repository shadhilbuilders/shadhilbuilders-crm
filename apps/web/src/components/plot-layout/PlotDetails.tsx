'use client';

// Details for the currently selected plot.
//
// Shows only what is actually known. The drawing states no sale price and the
// backend has none for a plot yet, so the price row says so explicitly rather
// than rendering `0` or a dash that reads as a real value of zero.

import {
  Badge,
  CardContent,
  CardHeader,
  CardRoot,
  CardTitle,
  Empty,
  Separator,
} from '@paalstack/react-ui';

import { PLOT_CATEGORY_LABEL, PLOT_STATUS_LABEL, PLOT_STATUS_FILL } from './plot-colors';
import { feetToFeetInches, formatSizeBothUnits, formatSqM } from './plot-format';
import type { Plot, PlotGeometry, PlotStatus } from './plot-types';

export interface PlotDetailsProps {
  /** The selected plot, or null when the requested plot does not exist. */
  plot: Plot | null;
  /** Traced geometry for the selected plot, for measurements the API will not carry. */
  geometry: PlotGeometry | null;
  /** What the user asked to see - distinguishes "nothing selected" from "not found". */
  requestedPlotNumber: number | null;
}

const STATUS_BADGE_VARIANT: Record<PlotStatus, 'success' | 'info' | 'destructive'> = {
  available: 'info',
  booked: 'success',
  blocked: 'destructive',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

export function PlotDetails({ plot, geometry, requestedPlotNumber }: PlotDetailsProps) {
  if (plot === null) {
    return (
      <CardRoot className="h-full" data-qa="plot-details">
        <CardContent className="p-4">
          <Empty
            title={
              requestedPlotNumber === null
                ? 'No plot selected'
                : `Plot ${requestedPlotNumber} not found`
            }
            description={
              requestedPlotNumber === null
                ? 'Click a plot on the layout, or search by plot number, to see its details here.'
                : `This layout has no plot numbered ${requestedPlotNumber}. Plot numbers run 1-125 (114-125 are the EWS plots).`
            }
          />
        </CardContent>
      </CardRoot>
    );
  }

  return (
    <CardRoot className="h-full" data-qa="plot-details">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block size-3 rounded-sm"
            style={{ backgroundColor: PLOT_STATUS_FILL[plot.status] }}
          />
          {`Plot ${plot.plotNumber}`}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_BADGE_VARIANT[plot.status]}>
            {PLOT_STATUS_LABEL[plot.status]}
          </Badge>
          <Badge variant="outline">{PLOT_CATEGORY_LABEL[plot.category]}</Badge>
        </div>

        <Separator />

        <dl className="divide-border divide-y">
          <Field label="Measured area">
            {geometry === null ? (
              <span className="text-muted-foreground font-normal">-</span>
            ) : (
              <>
                {formatSqM(geometry.areaSqM)} m&sup2;
                {plot.areaSqFt === undefined ? null : (
                  <span className="text-muted-foreground ml-1 font-normal">
                    ({plot.areaSqFt.toLocaleString('en-IN')} sq ft)
                  </span>
                )}
              </>
            )}
          </Field>
          <Field label="Measured size">
            {geometry === null
              ? '-'
              : formatSizeBothUnits(geometry.measuredSizeFt.width, geometry.measuredSizeFt.length)}
          </Field>
          <Field label="Printed on plan">
            {geometry === null || geometry.printedLabelsFt.length === 0 ? (
              <span className="text-muted-foreground font-normal">
                No dimension printed inside this plot
              </span>
            ) : (
              <span className="font-normal">
                {geometry.printedLabelsFt.map((value) => feetToFeetInches(value)).join(' / ')}
              </span>
            )}
          </Field>
          <Field label="Sale price">
            {plot.price === undefined ? (
              <span className="text-muted-foreground font-normal">Not set</span>
            ) : (
              plot.price
            )}
          </Field>
        </dl>

        <p className="text-muted-foreground text-xs">
          Measurements are traced from the approved layout drawing and checked against it. Selecting
          a plot does not reserve it - bookings are made and validated in the bookings module.
        </p>
      </CardContent>
    </CardRoot>
  );
}
