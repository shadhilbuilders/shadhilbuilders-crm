import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'New Lead',
};

export default function NewLeadLayout({ children }: { children: ReactNode }) {
  return children;
}
