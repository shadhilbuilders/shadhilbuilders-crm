import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Staff Permission',
};

export default function AdminStaffPermissionLayout({ children }: { children: ReactNode }) {
  return children;
}
