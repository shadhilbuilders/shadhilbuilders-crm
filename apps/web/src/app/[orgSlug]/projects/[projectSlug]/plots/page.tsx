import type { Metadata } from 'next';

import { PlotLayout } from '@/components/plot-layout/PlotLayout';

export const metadata: Metadata = {
  title: 'Plot layout',
};

/**
 * Interactive availability map for the approved CMDA layout.
 *
 * The page is a thin server component: all interaction lives in the client-only
 * `PlotLayout`. Project/org context comes from the enclosing layouts, so the
 * component can read `useProjectId()` for the future plot-status endpoint.
 */
export default function PlotsPage() {
  return <PlotLayout />;
}
