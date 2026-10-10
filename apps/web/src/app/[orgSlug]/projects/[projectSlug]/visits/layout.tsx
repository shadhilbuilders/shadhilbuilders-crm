import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Site Visits',
};

export default function VisitsLayout({ children }: { children: ReactNode }) {
  return children;
}
