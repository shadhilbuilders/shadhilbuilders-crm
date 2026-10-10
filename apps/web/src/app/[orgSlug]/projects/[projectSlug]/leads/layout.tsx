import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Lead Inbox',
};

export default function LeadsLayout({ children }: { children: ReactNode }) {
  return children;
}
