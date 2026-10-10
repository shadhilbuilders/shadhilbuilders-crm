import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Change password',
};

export default function ChangePasswordLayout({ children }: { children: ReactNode }) {
  return children;
}
