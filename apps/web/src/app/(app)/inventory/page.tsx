'use client';

// Inventory — villa/unit availability grid (DESIGN.md §2 module 4,
// Implementation Plan Week 7): Villa #, BHK, Facing, Sqft, Price, Status
// with Project/Phase/BHK/Facing/Status filters; click → detail for hold +
// booking flow. Units module is a backend stub; honest pending state until
// it lands. There is no Units DTO in api-types v1 — the page renders the
// locked column spec against the documented shape and flips live when the
// endpoint exists.
import { Heading, TypographyP } from '@paalstack/react-ui';

import { ModulePending } from '@/components/shared/ModulePending';

const INVENTORY_COLUMNS = [
  'Villa #',
  'BHK',
  'Facing',
  'Sqft',
  'Price (₹)',
  'Status',
] as const;

type UnitStatus = 'AVAILABLE' | 'HOLD' | 'TOKEN' | 'SOLD';

const STATUS_CLASS: Record<UnitStatus, string> = {
  AVAILABLE: 'bg-success-soft text-success-foreground',
  HOLD: 'bg-warning-soft text-warning-foreground',
  TOKEN: 'bg-info-soft text-info-foreground',
  SOLD: 'bg-destructive-soft text-destructive-foreground',
};

export default function InventoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <Heading className="mb-1">Inventory</Heading>
        <TypographyP className="text-muted-foreground text-sm">
          Shadhil Metro Heights · villa availability by phase, BHK, and facing.
        </TypographyP>
      </div>

      {/* Column spec preview — the real DataTable consumes /api/units when
          the inventory module exists. Kept visible so the surface is
          reviewable today. */}
      <div className="border-border overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border bg-muted/40 border-b text-left">
              {INVENTORY_COLUMNS.map((column) => (
                <th
                  key={column}
                  className="px-4 py-2.5 text-xs font-medium tracking-wide uppercase"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={INVENTORY_COLUMNS.length} className="text-muted-foreground px-4 py-10 text-center text-sm">
                No inventory yet — the units schema and endpoints ship with the
                inventory module (Implementation Plan Week 7).
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(STATUS_CLASS) as UnitStatus[]).map((status) => (
          <span
            key={status}
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}
          >
            {status}
          </span>
        ))}
      </div>

      <ModulePending
        title="Inventory grid"
        description="Full unit grid with hold + booking flow per unit (DESIGN.md module 4). The units module ships after leads (Week 7)."
        error={null}
      />

      <TypographyP className="text-muted-foreground text-xs">
        Unit states and their meaning: AVAILABLE → open for visits and holds;
        HOLD → temporarily blocked by a pending booking; TOKEN → token
        received, awaiting manager approval; SOLD → booking approved and
        closed.
      </TypographyP>
    </div>
  );
}