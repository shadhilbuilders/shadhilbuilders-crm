import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'User Details',
};

export default function AdminUserDetailLayout({ children }: { children: ReactNode }) {
  return children;
}
