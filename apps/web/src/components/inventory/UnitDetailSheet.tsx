'use client';

// UnitDetailSheet - slide-out detail panel for a single inventory unit
// (DESIGN.md module 4: "Click unit → detail panel with hold + booking
// flow"). Shows the unit's full spec + status and a "Create booking"
// action that deep-links to /bookings/new?unitId=<id> (the booking form
// pre-fills the unit picker from the query param).
import { Badge, Button, Sheet, Tabs } from '@paalstack/react-ui';
import { LuArrowRight } from '@paalstack/react-icons/lu';
import Link from 'next/link';

import { inventoryStatusBadgeVariant, labelFor } from '@/lib/labels';
import { currencyIntl, numberIntl } from '@/lib/format';
import { projectHref } from '@/lib/nav';
import { useSessionUser } from '@/lib/session';
import { useOrgSlug, useProjectSlug } from '@/lib/tenant-context';
import { useUnitPhotos, isForbidden } from '@/hooks/queries/customer-progress';
import { AssignedEngineerRow } from './AssignedEngineerRow';
import { UnitProgressTabContent, type ProgressUnit } from './UnitProgressTab';

import type { UnitRow } from '@/hooks/queries/inventory';

/**
 * Money as the wire sends it (a decimal string), or a dash when there is none.
 *
 * Null is a REAL case since 2026-11-08: a site-only role (ENGINEER) receives
 * null money because the server never selects the columns. `Number(null)` is
 * 0, so the naive version printed "₹0" - a claim that the villa is free. Both
 * null and undefined must read as "not available", never as a number.
 */
function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return currencyIntl.format(num);
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 p-2">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

/** Issue #7 slice 1: site-staff surface. For non-booking roles (ENGINEER,
 *  TELECALLER) there is no Details tab, so no tab chrome is rendered at
 *  all - the timeline GET decides what shows: skeleton while loading, the
 *  full progress panel on 2xx, and NOTHING on 403 (the documented contract:
 *  a non-member's Progress tab hides itself entirely, instead of leaving an
 *  empty tab shell). */
function UnitProgressGate({ unit }: { unit: ProgressUnit }) {
  // Shares the same TanStack query key as UnitProgressTabContent's own
  // useUnitPhotos call, so this resolves in one network round trip and the
  // panel below renders from cache without a second fetch.
  const photosQuery = useUnitPhotos(unit.id);
  if (isForbidden(photosQuery.error)) return null;
  return <UnitProgressTabContent unit={unit} />;
}

export function UnitDetailSheet({
  unit,
  onOpenChange,
}: {
  unit: UnitRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const { user } = useSessionUser();
  const canBook =
    user !== null &&
    (user.role === 'ADMIN' ||
      user.role === 'OWNER' ||
      user.role === 'MANAGER' ||
      user.role === 'SALES_EXEC');
  // Issue #7 slice 1: site-staff surface. The Progress tab renders for every
  // role INSIDE the sheet - its own visibility contract is the timeline GET
  // (a 403 non-member hides the tab entirely, inside UnitProgressTabContent).
  // The photo's phase comes from the unit itself (Unit.phaseId is required),
  // so no phase list is fetched here any more.

  if (unit === null) return null;
  // Only the progress tab's three fields - the tab must not gain access to
  // booking/money fields it has no business reading.
  const progressUnit: ProgressUnit = {
    id: unit.id,
    phaseId: unit.phaseId,
    phaseName: unit.phaseName,
  };
  const status = unit.status;
  const isAvailable = status === 'AVAILABLE';

  return (
    <Sheet
      open={unit !== null}
      onOpenChange={onOpenChange}
      trigger={null}
      side="right"
      className="w-full data-[side=right]:sm:max-w-xl"
      header={{
        title: `Unit ${unit.unitNumber}`,
        description: `${unit.projectName} · ${unit.phaseName}`,
      }}
      footer={{
        primaryAction:
          canBook && isAvailable ? (
            <Button
              as={Link}
              href={`${projectHref(orgSlug, projectSlug, '/bookings/new')}?unitId=${encodeURIComponent(unit.id)}`}
              rightIcon={<LuArrowRight className="size-4" />}
              data-qa="unit-book-button"
            >
              Create booking
            </Button>
          ) : null,
        secondaryAction: (
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            data-qa="unit-detail-close"
          >
            Close
          </Button>
        ),
      }}
    >
      <Tabs
        defaultValue="details"
        variant="line"
        className="px-4"
        tabs={
          canBook
            ? [
                {
                  label: 'Details',
                  value: 'details',
                  content: <UnitDetailsPanel unit={unit} />,
                },
                {
                  label: 'Progress',
                  value: 'progress',
                  content: <UnitProgressTabContent unit={progressUnit} />,
                },
              ]
            : [
                {
                  label: 'Progress',
                  value: 'progress',
                  content: <UnitProgressGate unit={progressUnit} />,
                },
              ]
        }
      />
    </Sheet>
  );
}

/** The unit spec card that used to be the sheet's whole body. */
function UnitDetailsPanel({ unit }: { unit: UnitRow }) {
  const orgSlug = useOrgSlug();
  const projectSlug = useProjectSlug();
  const { user } = useSessionUser();
  const canBook =
    user !== null &&
    (user.role === 'ADMIN' ||
      user.role === 'OWNER' ||
      user.role === 'MANAGER' ||
      user.role === 'SALES_EXEC');
  const status = unit.status;
  const badgeVariant = inventoryStatusBadgeVariant(status);
  const isAvailable = status === 'AVAILABLE';
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant={badgeVariant} data-qa="unit-detail-status">
          {labelFor('inventory', status)}
        </Badge>
        {!isAvailable ? (
          <span className="text-muted-foreground text-xs">
            {status === 'HOLD'
              ? 'Held by a pending booking.'
              : status === 'TOKEN'
                ? 'Token received, awaiting approval.'
                : 'Sold - no longer available.'}
          </span>
        ) : null}
        {canBook && isAvailable ? (
          <Button
            as={Link}
            size="sm"
            href={`${projectHref(orgSlug, projectSlug, '/bookings/new')}?unitId=${encodeURIComponent(unit.id)}`}
            rightIcon={<LuArrowRight className="size-4" />}
            data-qa="unit-book-button"
          >
            Create booking
          </Button>
        ) : null}
      </div>

      <div className="border-border divide-border divide-y rounded-lg border">
        <DetailRow
          label="Plot number"
          value={unit.plotNumber === null ? 'Not on the layout' : String(unit.plotNumber)}
        />
        <DetailRow label="BHK" value={`${unit.bhk} BHK`} />
        <DetailRow label="Facing" value={unit.facing ?? '-'} />
        <DetailRow
          label="Plot sq.ft"
          value={unit.sqft !== null ? numberIntl.format(unit.sqft) : '-'}
        />
        <DetailRow label="Buildup sq.ft" value={numberIntl.format(Number(unit.buildupSqft))} />
        {/* Money is withheld for site-only roles (2026-11-08). The rows are
            omitted rather than shown as "-", which would read as a missing
            value instead of a figure this role never receives. */}
        {unit.pricePerSqft === null ? null : (
          <DetailRow label="Per sq.ft price" value={formatMoney(unit.pricePerSqft)} />
        )}
        {unit.price === null ? null : (
          <DetailRow label="Total sq.ft price" value={formatMoney(unit.price)} />
        )}
        <DetailRow label="Phase" value={unit.phaseName} />
        <DetailRow label="Project" value={unit.projectName} />
        <AssignedEngineerRow unit={unit} />
      </div>

      {!canBook ? (
        <p className="text-muted-foreground text-xs">
          Only managers, sales executives, and admins can start a booking.
        </p>
      ) : null}
    </div>
  );
}
