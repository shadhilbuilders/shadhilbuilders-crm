import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Teams',
};

export default function AdminTeamsLayout({ children }: { children: ReactNode }) {
  return children;
}
