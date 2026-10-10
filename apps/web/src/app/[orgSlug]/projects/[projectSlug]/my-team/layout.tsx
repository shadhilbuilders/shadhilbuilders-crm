import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'My Team',
};

export default function MyTeamLayout({ children }: { children: ReactNode }) {
  return children;
}
