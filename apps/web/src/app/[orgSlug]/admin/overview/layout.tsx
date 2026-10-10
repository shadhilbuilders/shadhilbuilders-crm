import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Admin Overview',
};

export default function AdminOverviewLayout({ children }: { children: ReactNode }) {
  return children;
}
