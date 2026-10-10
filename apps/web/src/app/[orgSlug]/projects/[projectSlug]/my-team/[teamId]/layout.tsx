import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Team Details',
};

export default function MyTeamDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
