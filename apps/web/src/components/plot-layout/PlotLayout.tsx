'use client';

// Interactive residential plot layout.
//
// Orchestrates the map, the search/filter bar, the legend and the details
// panel, and owns the one piece of state they all share: which plot is
// selected.
//
// Availability comes from `usePlotStatuses` (GET /api/inventory/plots) and is
// joined to the traced geometry here. The 125 polygons are a static trace of the
// approved drawing and the statuses are live, so the two halves arrive from
// different places on purpose - a status change repaints the map without a
// coordinate moving.
//
// Scope note: this surface is READ-ONLY. Selecting a plot never writes.
// Booking goes through the bookings module, which validates availability and
// guards against concurrent bookings server-side.

import { Alert, Button, Skeleton } from '@paalstack/react-ui';
import { useMemo, useRef, useState } from 'react';

import { usePlotStatuses } from '@/hooks/queries/inventory';
import { useProjectId } from '@/lib/tenant-context';

import { buildPlots, countByStatus, plotMatchesFilters } from './plot-data';
import { PLOT_GEOMETRY } from './plot-geometry';
import { PlotDetails } from './PlotDetails';
import { PlotLegend } from './PlotLegend';
import { PlotMap } from './PlotMap';
import { PlotSearch } from './PlotSearch';
import type { PlotFilters } from './plot-types';

const DEFAULT_FILTERS: PlotFilters = { category: 'all', status: 'all', query: '' };

interface FocusRequest {
  plotNumber: number;
  /** Bumped on every request so asking for the same plot twice still recentres. */
  nonce: number;
}

export function PlotLayout() {
  const projectId = useProjectId();
  const statusQuery = usePlotStatuses(projectId ?? undefined);

  const [selectedPlotNumber, setSelectedPlotNumber] = useState<number | null>(null);
  const [filters, setFilters] = useState<PlotFilters>(DEFAULT_FILTERS);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusNonce = useRef(0);

  const rows = statusQuery.data?.rows ?? [];
  const plots = useMemo(() => buildPlots(PLOT_GEOMETRY, rows), [rows]);

  const matches = useMemo(
    () => plots.filter((plot) => plotMatchesFilters(plot, filters)),
    [plots, filters]
  );
  const matchingNumbers = useMemo(() => new Set(matches.map((plot) => plot.plotNumber)), [matches]);
  const counts = useMemo(() => countByStatus(plots), [plots]);

  const geometryByNumber = useMemo(
    () => new Map(PLOT_GEOMETRY.map((shape) => [shape.plotNumber, shape])),
    []
  );

  const selectedPlot = useMemo(
    () => plots.find((plot) => plot.plotNumber === selectedPlotNumber) ?? null,
    [plots, selectedPlotNumber]
  );

  /** Select a plot and bring it into view (used by search and the filter chips). */
  const locatePlot = (plotNumber: number) => {
    focusNonce.current += 1;
    setSelectedPlotNumber(plotNumber);
    setFocusRequest({ plotNumber, nonce: focusNonce.current });
    // Drop any filter that would hide the plot the user just asked for -
    // otherwise they land on a dimmed shape that cannot be clicked.
    setFilters((current) => {
      const target = plots.find((plot) => plot.plotNumber === plotNumber);
      if (target === undefined) return current;
      return plotMatchesFilters(target, current) ? current : DEFAULT_FILTERS;
    });
  };

  const handleLocate = (query: string) => {
    const trimmed = query.trim();
    if (trimmed === '') return;
    // A number with no matching plot still selects, so the panel can say so
    // instead of silently doing nothing.
    setFocusRequest(null);
    locatePlot(Number(trimmed));
  };

  const handleResetFilters = () => setFilters(DEFAULT_FILTERS);

  if (statusQuery.isPending) {
    return (
      <div className="flex flex-col gap-4" data-qa="plot-layout-loading">
        <Skeleton className="h-9 w-full max-w-2xl" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Skeleton className="aspect-[601/508] w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (statusQuery.isError) {
    return (
      <Alert
        title="Could not load plot availability"
        description={
          <span className="flex flex-col gap-2">
            <span>
              {statusQuery.error instanceof Error
                ? statusQuery.error.message
                : 'The availability request failed.'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => void statusQuery.refetch()}
              data-qa="plot-layout-retry"
            >
              Try again
            </Button>
          </span>
        }
        data-qa="plot-layout-error"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        // An empty row set is a real answer, not a failure: the CRM identifies a
        // plot by a unit number that IS a plot number, and this project has no
        // such unit. Say so, because an all-grey layout otherwise looks broken.
        <Alert
          title="No unit in this project is numbered by plot yet"
          description={
            'Every plot therefore reads available. A plot is matched to a unit by number: a unit numbered ' +
            '"37" is plot 37. Units numbered any other way - for example "D-101" - are not plots and are ' +
            'ignored rather than guessed at.'
          }
          data-qa="plot-no-unit-mapping"
        />
      ) : null}

      <PlotSearch
        filters={filters}
        onFiltersChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
        onLocate={handleLocate}
        matches={matches}
        totalCount={plots.length}
        onSelectPlot={locatePlot}
        onResetFilters={handleResetFilters}
      />

      <PlotLegend counts={counts} matchCount={matches.length} totalCount={plots.length} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <PlotMap
          plots={plots}
          matchingNumbers={matchingNumbers}
          selectedPlotNumber={selectedPlotNumber}
          onSelect={setSelectedPlotNumber}
          focusRequest={focusRequest}
        />
        <PlotDetails
          plot={selectedPlot}
          geometry={
            selectedPlotNumber === null ? null : (geometryByNumber.get(selectedPlotNumber) ?? null)
          }
          requestedPlotNumber={selectedPlotNumber}
        />
      </div>
    </div>
  );
}
