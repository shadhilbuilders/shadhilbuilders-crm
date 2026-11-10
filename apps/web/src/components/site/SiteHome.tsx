'use client';

// SiteHome (2026-11-08): the site engineer's first screen.
//
// WHY IT EXISTS: the engineer used to land on `/inventory` - a sales grid of
// rupees, booking status and pagination. Their real question is "which villa
// have I not photographed yet", and nothing on that grid answers it.
//
// This component is PRESENTATIONAL: every input arrives as a prop (`rows`,
// `filter`, `search`, `now`), so each state is renderable and testable without a
// query client. `site/page.tsx` owns the fetching and the local state; the pure
// shaping lives in `lib/site-units.ts`.
//
// Colour rule: the four documentation states are the ONLY hue on a row, and
// they sit on the media square and the badge. Every state also says its name in
// words, so a colour-blind engineer in sunlight still reads the page. The phase
// rail is the one decorative accent, stable per phase.
import {
  Alert,
  Badge,
  Button,
  CardContent,
  CardHeader,
  CardRoot,
  CardTitle,
  Empty,
  InputGroup,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Skeleton,
  ToggleGroup,
} from '@paalstack/react-ui';
import {
  LuCalendarCheck,
  LuCamera,
  LuCheck,
  LuChevronRight,
  LuClockAlert,
  LuSearch,
} from '@paalstack/react-icons/lu';
import Link from 'next/link';
import type { ComponentType, SVGProps } from 'react';

import type { SiteUnitScope } from '@shadhil/api-types';

import type { UnitRow } from '@/hooks/queries/inventory';
import { projectHref } from '@/lib/nav';
import {
  unitPhotoState,
  unitPhotoStateBadgeVariant,
  unitPhotoStateLabel,
  unitPhotoStateSurface,
  type UnitPhotoState,
} from '@/lib/site-photos';
import {
  groupByPhase,
  phaseAccent,
  phaseAccentClass,
  SITE_EMPTY_COPY,
  SITE_SCOPE_COPY,
  siteEmptyCopyFor,
  siteCounts,
  siteRowMeta,
  siteUnits,
  type SiteFilter,
} from '@/lib/site-units';

export type SiteHomeProps = {
  projectName: string;
  orgSlug: string | null;
  projectSlug: string | null;
  /** Every unit the API returned (up to the server's 200 cap). */
  rows: readonly UnitRow[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  filter: SiteFilter;
  onFilterChange: (next: SiteFilter) => void;
  search: string;
  onSearchChange: (next: string) => void;
  /** True when the row count hit the server cap, so counts would be a lie. */
  capped: boolean;
  /** Injected so every boundary below is deterministic in tests. */
  now: Date;
  /** Whose villas these are (server-decided). Null/undefined = unknown yet. */
  scope?: SiteUnitScope | null;
  /** False for read-only viewers (manager/admin/owner). */
  canCapture?: boolean;
};

const FILTER_OPTIONS: { value: SiteFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'needs', label: 'Needs a photo' },
  { value: 'updated', label: 'Updated' },
  { value: 'none', label: 'No photos' },
];

type StatIcon = ComponentType<SVGProps<SVGSVGElement> & { className?: string }>;

function StatTile({
  label,
  value,
  state,
  qa,
  icon: Icon,
}: {
  label: string;
  value: number | null;
  state: UnitPhotoState;
  qa: string;
  icon: StatIcon;
}) {
  return (
    <div
      className={`min-w-0 rounded-lg px-2 py-2 sm:px-3 sm:py-2.5 ${unitPhotoStateSurface(state)}`}
      data-qa={qa}
    >
      {/* Icon + value share one row so the number stays readable when the
          three tiles squeeze to ~109px at 375. min-w-0 stops long labels from
          blowing the grid cell. */}
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Icon className="size-3.5 shrink-0 sm:size-4" aria-hidden="true" />
        <p className="min-w-0 truncate text-base font-semibold tabular-nums sm:text-lg">
          {/* `null` means "the list was capped, this number would lie" - say so
              rather than showing an undercount as if it were a total. */}
          {value === null ? '-' : value}
        </p>
      </div>
      {/* h-8 reserves two lines. At 375 "Updated this week" wraps while
          "No photos yet" fits on one; reserving the space keeps the numbers
          on one baseline across all three. */}
      <p className="mt-0.5 h-8 text-[11px] leading-4 text-pretty sm:text-xs">{label}</p>
    </div>
  );
}

function StateBadge({ state }: { state: UnitPhotoState }) {
  return (
        <Badge
          variant={unitPhotoStateBadgeVariant(state)}
          data-qa="site-unit-state-badge"
          data-state={state}
        >
          {unitPhotoStateLabel(state)}
        </Badge>
  );
}

function UnitRowItem({
  unit,
  href,
  now,
  showEngineer,
}: {
  unit: UnitRow;
  href: string;
  now: Date;
  /** Read-only viewers see which engineer owns the villa. */
  showEngineer: boolean;
}) {
  const state = unitPhotoState(unit, now);
  return (
    <Item asChild variant="default" className="px-3">
      <Link href={href} data-qa="site-unit-row">
        <ItemMedia
          variant="icon"
          className={`size-10 rounded-lg ${unitPhotoStateSurface(state)}`}
        >
          {state === 'none' ? (
            <LuCamera className="size-5" aria-hidden="true" />
          ) : (
            <LuCheck className="size-5" aria-hidden="true" />
          )}
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="tabular-nums">{unit.unitNumber}</ItemTitle>
          <ItemDescription data-qa="site-unit-staleness">
            {siteRowMeta(unit, now)}
            {showEngineer ? ` · ${unit.assignedEngineerName ?? 'Unassigned'}` : ''}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <StateBadge state={state} />
          <LuChevronRight className="text-muted-foreground size-4" aria-hidden="true" />
        </ItemActions>
      </Link>
    </Item>
  );
}

function HomeSkeleton() {
  return (
    <div data-qa="site-home-skeleton" role="status" aria-busy="true" aria-label="Loading villas">
      <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-17 rounded-lg sm:h-16" />
        ))}
      </div>
      <div className="mt-4 space-y-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export function SiteHome({
  projectName,
  orgSlug,
  projectSlug,
  rows,
  isLoading,
  isError,
  onRetry,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  capped,
  now,
  scope = null,
}: SiteHomeProps) {
  const counts = siteCounts(rows, now);
  const visible = siteUnits(rows, { filter, search, now });
  const groups = groupByPhase(visible);

  return (
    <div className="space-y-4" data-qa="site-home">
      <header>
        <h1 className="text-2xl font-semibold">Site updates</h1>
        <p className="text-muted-foreground text-sm">{projectName}</p>
        {scope !== null ? (
          <p className="text-muted-foreground text-xs" data-qa="site-scope-line">
            {SITE_SCOPE_COPY[scope]}
          </p>
        ) : null}
      </header>

      {isLoading ? (
        <HomeSkeleton />
      ) : isError ? (
        <Alert
          softBackground="danger"
          data-qa="site-home-error"
          title="Could not load the villas for this project."
          description={
            <Button
              type="button"
              variant="outline"
              className="mt-1"
              onClick={onRetry}
              data-qa="site-home-retry"
            >
              Try again
            </Button>
          }
        />
      ) : (
        <>
          {/* Counts are computed from the returned rows, so a capped list says
              so instead of showing an undercount as a total. */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5 sm:gap-2" aria-label="Photo coverage">
            <StatTile
              label="Needs a photo"
              value={capped ? null : counts.needs}
              state="stale"
              qa="site-stat-needs"
              icon={LuClockAlert}
            />
            <StatTile
              label="Updated this week"
              value={capped ? null : counts.updated}
              state="week"
              qa="site-stat-week"
              icon={LuCalendarCheck}
            />
            <StatTile
              label="No photos yet"
              value={capped ? null : counts.none}
              state="none"
              qa="site-stat-none"
              icon={LuCamera}
            />
          </div>
          {capped ? (
            <p className="text-muted-foreground text-xs" data-qa="site-home-cap-notice">
              Showing the first 200 units
            </p>
          ) : null}

          <div data-qa="site-filter">
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(next) => {
                const value = Array.isArray(next) ? next[0] : next;
                if (value !== undefined) onFilterChange(value as SiteFilter);
              }}
              items={FILTER_OPTIONS.map((option) => ({
                value: option.value,
                content: option.label,
                'data-qa': `site-filter-${option.value}`,
                // Library default selected fill is muted; site filter should
                // read as secondary so the active chip is obvious outdoors.
                className:
                  'rounded-md! transition-none data-[state=on]:bg-secondary data-[state=on]:text-secondary-foreground aria-pressed:bg-secondary aria-pressed:text-secondary-foreground',
              }))}
            />
          </div>

          <InputGroup
            addonStart={<LuSearch aria-hidden="true" />}
            inputProps={{
              'data-qa': 'site-unit-search',
              placeholder: 'Find a villa number',
              value: search,
              onChange: (event) => onSearchChange(event.target.value),
              'aria-label': 'Find a villa number',
            }}
          />

          {rows.length === 0 ? (
            <div data-qa="site-home-empty">
              <Empty
                media={<LuCamera className="size-full" />}
                mediaVariant="icon"
                title={siteEmptyCopyFor(scope).title}
                description={siteEmptyCopyFor(scope).body}
              />
            </div>
          ) : visible.length === 0 ? (
            // A filter that matches nothing is a DIFFERENT fact from a project
            // with no villas. One quiet line, not the same hero.
            <p className="text-muted-foreground py-8 text-center text-sm" data-qa="site-filter-empty">
              {SITE_EMPTY_COPY.filtered.title}
            </p>
          ) : (
            <div className="space-y-4">
              {groups.map((group, index) => (
                <CardRoot
                  key={group.phaseId}
                  className={`border-l-4 ${phaseAccentClass(phaseAccent(index))}`}
                  data-qa="site-phase-group"
                >
                  <CardHeader>
                    {/* h2, not the CardTitle default h3: the page's outline is
                        h1 "Site updates" → h2 per phase. Shipping h1 → h3 skips a
                        level (axe: heading-order), and the phases ARE the
                        sections of this page. */}
                    <CardTitle
                      as="h2"
                      className="flex items-baseline gap-2 text-base"
                    >
                      {group.phaseName}
                      {/* The count is a sibling span, so the visual gap comes
                          from the flex gap (it measured 8px). Without a text
                          separator the ACCESSIBLE name and `textContent` read
                          "Phase A7 units", which a screen reader and a browser
                          find-on-page both mangle. The separator is a real
                          text node with the same gap, so nothing shifts. */}
                      <span aria-hidden="true">·</span>
                      <span className="text-muted-foreground text-xs font-normal">
                        {group.units.length} {group.units.length === 1 ? 'unit' : 'units'}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-0">
                    {/* ItemGroup renders `role="list"`, and ARIA requires its
                        children to be `listitem`. An `Item` is a plain div (it
                        becomes an <a> here, via asChild), so the row is wrapped
                        in a real <li> - otherwise axe reports a critical
                        aria-required-children violation. */}
                    <ItemGroup role="list">
                      {group.units.map((unit) => (
                        <li key={unit.id} className="contents">
                          <UnitRowItem
                            unit={unit}
                            href={projectHref(orgSlug, projectSlug, `/site/${unit.id}`)}
                            now={now}
                            showEngineer={scope === 'MANAGED' || scope === 'ALL'}
                          />
                        </li>
                      ))}
                    </ItemGroup>
                  </CardContent>
                </CardRoot>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
