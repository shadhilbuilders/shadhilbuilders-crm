import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { InventoryRouteGate } from '@/components/inventory/InventoryRouteGate';

export const metadata: Metadata = {
  title: 'Inventory',
};

export default function InventoryLayout({ children }: { children: ReactNode }) {
  // 2026-11-08: the segment is closed to site-only roles (ENGINEER). The gate
  // lives HERE, above every `/inventory/*` page, so the grid's queries never
  // mount for a role that may not read prices - a per-page check would leave
  // the next inventory route unguarded by default. See the gate's header.
  return <InventoryRouteGate>{children}</InventoryRouteGate>;
}
