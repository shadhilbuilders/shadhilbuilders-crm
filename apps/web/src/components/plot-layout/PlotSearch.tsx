'use client';

// Search + filters for the plot map.
//
// The dataset is a fixed, local layout (125 plots), so filtering happens in
// the browser over the full set - there is no server page to be wrong about.
// When plot statuses start coming from the API this stays correct: the filter
// narrows the loaded set, and the map only dims what it has.

import { Button, Input, Select } from '@paalstack/react-ui';
import { LuSearch, LuX } from '@paalstack/react-icons/lu';
import { useEffect, useState } from 'react';

import { PLOT_STATUS_LABEL } from './plot-colors';
import type { Plot, PlotFilters, PlotStatus } from './plot-types';

export interface PlotSearchProps {
  filters: PlotFilters;
  onFiltersChange: (patch: Partial<PlotFilters>) => void;
  /** Called on submit with the typed plot number - selects it if it exists. */
  onLocate: (query: string) => void;
  /** Plots matching the current filters, in plot-number order. */
  matches: readonly Plot[];
  totalCount: number;
  onSelectPlot: (plotNumber: number) => void;
  onResetFilters: () => void;
}

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'All categories' },
  { value: 'regular', label: 'Regular (1-113)' },
  { value: 'ews', label: 'EWS (114-125)' },
];

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  ...(['available', 'booked', 'blocked'] as const).map((status) => ({
    value: status,
    label: PLOT_STATUS_LABEL[status],
  })),
];

/** How many matching plot chips to render before collapsing to a count. */
const MAX_CHIPS = 14;

export function PlotSearch({
  filters,
  onFiltersChange,
  onLocate,
  matches,
  totalCount,
  onSelectPlot,
  onResetFilters,
}: PlotSearchProps) {
  const [draft, setDraft] = useState(filters.query);

  // Keep the input in step if the query is reset from outside (the Clear button).
  useEffect(() => {
    setDraft(filters.query);
  }, [filters.query]);

  const filtersActive =
    filters.query.trim() !== '' || filters.category !== 'all' || filters.status !== 'all';
  const queryMissed = filters.query.trim() !== '' && matches.length === 0;

  return (
    <div className="flex flex-col gap-2" data-qa="plot-search">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-44 flex-1">
          <LuSearch
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            value={draft}
            // Digits only: a plot "number" has no letters, and stripping them
            // means a pasted "Plot 20" still lands on plot 20.
            onChange={(event) => {
              const digits = event.target.value.replace(/[^0-9]/g, '').slice(0, 3);
              setDraft(digits);
              onFiltersChange({ query: digits });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onLocate(draft);
              }
            }}
            inputMode="numeric"
            placeholder="Find plot number (1-125)"
            aria-label="Find a plot by number"
            className="pl-8"
            data-qa="plot-search-input"
          />
        </div>

        <Select
          value={filters.category}
          onValueChange={(next) =>
            onFiltersChange({ category: (next ?? 'all') as PlotFilters['category'] })
          }
          options={CATEGORY_OPTIONS}
          placeholder="All categories"
          className="w-44"
          data-qa="plot-category-filter"
        />
        <Select
          value={filters.status}
          onValueChange={(next) =>
            onFiltersChange({ status: (next ?? 'all') as PlotStatus | 'all' })
          }
          options={STATUS_OPTIONS}
          placeholder="All statuses"
          className="w-40"
          data-qa="plot-status-filter"
        />
        {filtersActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onResetFilters}
            data-qa="plot-filters-reset"
          >
            <LuX />
            Clear
          </Button>
        ) : null}
      </div>

      {queryMissed ? (
        <p className="text-muted-foreground text-xs" role="status" data-qa="plot-search-empty">
          {`No plot numbered "${filters.query}"${
            filters.category !== 'all' || filters.status !== 'all'
              ? ' with the current filters'
              : ''
          }. Plot numbers run 1-125.`}
        </p>
      ) : filters.query.trim() === '' ? null : (
        <div className="flex flex-wrap items-center gap-1.5" data-qa="plot-search-matches">
          <span className="text-muted-foreground text-xs">Matches:</span>
          {matches.slice(0, MAX_CHIPS).map((plot) => (
            <Button
              key={plot.id}
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              onClick={() => onSelectPlot(plot.plotNumber)}
              data-qa={`plot-search-match-${plot.plotNumber}`}
            >
              {plot.plotNumber}
            </Button>
          ))}
          {matches.length > MAX_CHIPS ? (
            <span className="text-muted-foreground text-xs">{`+${matches.length - MAX_CHIPS} more`}</span>
          ) : null}
        </div>
      )}

      {filtersActive && !queryMissed ? (
        <p className="text-muted-foreground text-xs" role="status">
          {`${matches.length} of ${totalCount} plots shown in full; the rest are dimmed on the layout.`}
        </p>
      ) : null}
    </div>
  );
}
