'use client';

// UnitDetailSheet - slide-out detail panel for a single inventory unit
// (DESIGN.md module 4: "Click unit → detail panel with hold + booking
// flow"). Shows the unit's full spec + status and a "Create booking"
// action that deep-links to /bookings/new?unitId=<id> (the booking form
// pre-fills the unit picker from the query param).
import { Badge, Button, Sheet } from '@paalstack/react-ui';
import { LuArrowRight } from '@paalstack/react-icons/lu';
import Link from 'next/link';

import { labelFor, INVENTORY_STATUSES, type InventoryStatus } from '@/lib/labels';
import { currencyIntl, numberIntl } from '@/lib/format';
import { projectHref } from '@/lib/nav';
import { useSessionUser } from '@/lib/session';

import type { UnitRow } from '@/hooks/queries/inventory';

const STATUS_BADGE_VARIANT: Record<InventoryStatus, 'success' | 'warning' | 'info' | 'destructive'> = {
  AVAILABLE: 'success',
  HOLD: 'warning',
  TOKEN: 'info',
  SOLD: 'destructive',
};

function isInventoryStatus(value: string): value is InventoryStatus {
  return (INVENTORY_STATUSES as readonly string[]).includes(value);
}

function formatMoney(value: string | undefined): string {
  if (value === undefined) return '-';
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

export function UnitDetailSheet({
  unit,
  onOpenChange,
  projectId,
}: {
  unit: UnitRow | null;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
}) {
  const { user } = useSessionUser();
  const canBook =
    user !== null &&
    (user.role === 'ADMIN' ||
      user.role === 'OWNER' ||
      user.role === 'MANAGER' ||
      user.role === 'SALES_EXEC');

  if (unit === null) return null;
  const status = unit.status;
  const badgeVariant = isInventoryStatus(status)
    ? STATUS_BADGE_VARIANT[status]
    : 'muted';
  const isAvailable = status === 'AVAILABLE';

  return (
    <Sheet
      open={unit !== null}
      onOpenChange={onOpenChange}
      trigger={null}
      side="right"
      header={{
        title: `Unit ${unit.unitNumber}`,
        description: `${unit.projectName} · ${unit.phaseName}`,
      }}
      footer={{
        primaryAction:
          canBook && isAvailable ? (
            <Button as={Link} href={`${projectHref(projectId, '/bookings/new')}?unitId=${encodeURIComponent(unit.id)}`} rightIcon={<LuArrowRight className="size-4" />} data-qa="unit-book-button">
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
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <Badge
            variant={badgeVariant}
            data-qa="unit-detail-status"
          >
            {isInventoryStatus(status) ? labelFor('inventory', status) : status || '-'}
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
        </div>

        <div className="border-border divide-y divide-border rounded-lg border">
          <DetailRow label="BHK" value={`${unit.bhk} BHK`} />
          <DetailRow label="Facing" value={unit.facing ?? '-'} />
          <DetailRow label="Sqft" value={unit.sqft !== null ? numberIntl.format(unit.sqft) : '-'} />
          <DetailRow label="Price" value={formatMoney(unit.price)} />
          <DetailRow label="Phase" value={unit.phaseName} />
          <DetailRow label="Project" value={unit.projectName} />
        </div>

        {!canBook ? (
          <p className="text-muted-foreground text-xs">
            Only managers, sales executives, and admins can start a booking.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
