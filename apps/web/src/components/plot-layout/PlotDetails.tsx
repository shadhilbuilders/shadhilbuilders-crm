'use client';

// Details for the currently selected plot.
//
// Two halves, kept visibly apart: what the DRAWING says about the plot (area and
// printed dimensions, measured from the traced polygon) and what the CRM
// actually holds - the villa that carries this plot number and, when there is
// one, the live booking on it.
//
// Nothing here invents a record. A plot with no villa says so; a villa that is
// held but whose booking is invisible to this user says THAT, rather than
// "no booking", which would be a claim the panel cannot support.

import {
  Badge,
  Button,
  CardContent,
  CardHeader,
  CardRoot,
  CardTitle,
  Empty,
  Separator,
} from '@paalstack/react-ui';
import Link from 'next/link';

import { currencyIntl, numberIntl } from '@/lib/format';
import { bookingStatusBadgeVariant, inventoryStatusBadgeVariant, labelFor } from '@/lib/labels';
import { projectHref } from '@/lib/nav';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';

import { PLOT_CATEGORY_LABEL, PLOT_STATUS_FILL, PLOT_STATUS_LABEL } from './plot-colors';
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

/**
 * Badge variant per status.
 *
 * The variant must agree with the colour the MAP paints the plot in, or the
 * panel and the plan disagree about the same plot: available is green
 * (`success`), booked is red (`danger`), blocked is gold (`warning` - the
 * app's amber, which is the same colour family as the map's gold fill).
 */
const STATUS_BADGE_VARIANT: Record<PlotStatus, 'success' | 'danger' | 'warning'> = {
  available: 'success',
  booked: 'danger',
  blocked: 'warning',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-right text-sm font-medium">{children}</dd>
    </div>
  );
}

/** Money as the wire sends it (a decimal string), or a dash when there is none. */
function formatMoney(value: string | undefined): string {
  if (value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

export function PlotDetails({ plot, geometry, requestedPlotNumber }: PlotDetailsProps) {
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();

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

  // The API orders the claims most binding first, so the first unit is the one
  // the plot's colour came from.
  const claim = plot.units[0] ?? null;
  const unit = claim?.unit ?? null;
  const booking = claim?.booking ?? null;
  const otherClaims = plot.units.slice(1);

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
        </dl>

        <Separator />

        {unit === null ? (
          <div className="space-y-1" data-qa="plot-no-villa">
            <p className="text-sm font-medium">No villa on this plot yet</p>
            <p className="text-muted-foreground text-xs">
              A villa appears here once it carries this plot number. A villa&apos;s plot number is
              set on the villa itself, separately from its door number.
            </p>
          </div>
        ) : (
          <div className="space-y-3" data-qa="plot-villa">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-muted-foreground text-xs">Villa (door number)</span>
                <Button
                  as={Link}
                  variant="link"
                  className="text-link h-auto p-0 justify-start"
                  href={`${projectHref(orgSlug, projectSlug, '/inventory')}?unit=${encodeURIComponent(unit.id)}`}
                  data-qa="plot-unit-link"
                >
                  {unit.unitNumber}
                </Button>
              </div>
              <Badge variant={inventoryStatusBadgeVariant(unit.status)} data-qa="plot-unit-status">
                {labelFor('inventory', unit.status)}
              </Badge>
            </div>

            <dl className="divide-border divide-y">
              <Field label="BHK">{`${unit.bhk} BHK`}</Field>
              <Field label="Facing">{unit.facing ?? '-'}</Field>
              <Field label="Plot sq.ft">
                {unit.sqft === null ? '-' : numberIntl.format(unit.sqft)}
              </Field>
              <Field label="Buildup sq.ft">{numberIntl.format(Number(unit.buildupSqft))}</Field>
              <Field label="Total price">{formatMoney(unit.price)}</Field>
              <Field label="Phase">{unit.phaseName}</Field>
            </dl>

            {booking === null ? (
              <p className="text-muted-foreground text-xs" data-qa="plot-booking-none">
                {unit.status === 'AVAILABLE'
                  ? 'No booking on this villa.'
                  : 'A booking is holding this villa, and it is not visible to you.'}
              </p>
            ) : (
              <div className="space-y-2" data-qa="plot-booking">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground text-xs">Booking</span>
                  <Badge
                    variant={bookingStatusBadgeVariant(booking.status)}
                    data-qa="plot-booking-status"
                  >
                    {labelFor('booking', booking.status)}
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground text-xs">Buyer</span>
                  <Button
                    as={Link}
                    variant="link"
                    className="text-link h-auto p-0"
                    href={projectHref(orgSlug, projectSlug, `/leads/${booking.leadId}`)}
                    data-qa="plot-booking-lead-link"
                  >
                    {booking.leadName}
                  </Button>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground text-xs">Amount</span>
                  <span className="text-sm font-medium">{formatMoney(booking.amount)}</span>
                </div>
                <Button
                  as={Link}
                  variant="outline"
                  size="sm"
                  href={projectHref(orgSlug, projectSlug, `/bookings/${booking.id}`)}
                  data-qa="plot-booking-link"
                >
                  Open booking
                </Button>
              </div>
            )}

            {otherClaims.length > 0 ? (
              <p className="text-muted-foreground text-xs" data-qa="plot-other-claims">
                {otherClaims.length === 1
                  ? '1 more villa also carries'
                  : `${otherClaims.length} more villas also carry`}{' '}
                plot {plot.plotNumber}: {otherClaims.map((c) => c.unit.unitNumber).join(', ')}.
              </p>
            ) : null}
          </div>
        )}

        <p className="text-muted-foreground text-xs">
          Measurements are traced from the approved layout drawing and checked against it. Selecting
          a plot does not reserve it - bookings are made and validated in the bookings module.
        </p>
      </CardContent>
    </CardRoot>
  );
}
