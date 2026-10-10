import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'New Unit',
};

export default function NewUnitLayout({ children }: { children: ReactNode }) {
  return children;
}
