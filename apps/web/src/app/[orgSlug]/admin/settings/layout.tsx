import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Organization Settings',
};

export default function AdminSettingsLayout({ children }: { children: ReactNode }) {
  return children;
}
