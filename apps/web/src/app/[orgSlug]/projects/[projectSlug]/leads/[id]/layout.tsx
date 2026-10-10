import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Lead Details',
};

export default function LeadDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
