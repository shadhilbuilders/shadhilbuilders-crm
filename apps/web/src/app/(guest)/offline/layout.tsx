import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Offline',
};

export default function OfflineLayout({ children }: { children: ReactNode }) {
  return children;
}
